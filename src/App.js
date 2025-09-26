import React, { useEffect, useState, useRef, useCallback } from 'react';
import io from 'socket.io-client';
import Peer from 'simple-peer';
import './App.css';

const API_URL = 'https://rxj-info-api.onrender.com';

// ================== FIX #1: STUN Server Configuration ==================
// This helps peers connect more reliably across different networks.
const peerConfig = {
    config: {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
        ],
    },
};

function App() {
    const [status, setStatus] = useState('Connecting to network...');
    const [myFiles, setMyFiles] = useState({});
    const [peerFiles, setPeerFiles] = useState({});

    const socketRef = useRef();
    const peersRef = useRef({});
    const fileChunksRef = useRef({});
    const myFilesRef = useRef(myFiles);
    myFilesRef.current = myFiles;

    const currentlyReceivingFile = useRef(null);

    const cleanupPeer = useCallback((userID) => {
        console.log(`Cleaning up peer ${userID}`);
        if (peersRef.current[userID]) {
            peersRef.current[userID].destroy();
            delete peersRef.current[userID];
        }
        setPeerFiles(prev => {
            const newFiles = { ...prev };
            Object.keys(newFiles).forEach(fileName => {
                if (newFiles[fileName] && newFiles[fileName].peer === userID) {
                    delete newFiles[fileName];
                }
            });
            return newFiles;
        });
    }, []);

    const handleData = useCallback((data, peer) => {
        if (typeof data !== 'string') {
            const fileName = currentlyReceivingFile.current;
            if (fileName && fileChunksRef.current[fileName]) {
                fileChunksRef.current[fileName].chunks.push(data);
            }
            return;
        }

        try {
            const message = JSON.parse(data);
            if (message.type === 'file-list') {
                const filesFromPeer = message.files.reduce((obj, file) => {
                    const peerID = Object.keys(peersRef.current).find(id => peersRef.current[id] === peer);
                    if (peerID) {
                        obj[file.name] = { ...file, peer: peerID };
                    }
                    return obj;
                }, {});
                setPeerFiles(prev => ({ ...prev, ...filesFromPeer }));
            } else if (message.type === 'file-request') {
                const file = myFilesRef.current[message.name];
                if (file) {
                    sendFile(file, peer);
                } else {
                    console.error(`File ${message.name} not found for sending.`);
                }
            } else if (message.type === 'file-done') {
                const fileName = message.name;
                const fileInfo = fileChunksRef.current[fileName];
                if (fileInfo) {
                    const completeFile = new Blob(fileInfo.chunks);
                    const url = URL.createObjectURL(completeFile);
                    const a = document.createElement('a'); a.href = url; a.download = fileName; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
                    delete fileChunksRef.current[fileName];
                    currentlyReceivingFile.current = null;
                }
            }
        } catch (e) { console.error('Error handling data', e, "Raw data:", data); }
    }, []); 

    const setupPeerEvents = useCallback((peer, peerID) => {
        setStatus(`Connected to a peer! Ready to share.`);
        peer.on('connect', () => {
            console.log(`Connection established with ${peerID}`);
            const files = Object.values(myFilesRef.current).map(f => ({ name: f.name, size: f.size }));
            if (files.length > 0) {
               peer.send(JSON.stringify({ type: 'file-list', files }));
            }
        });
        peer.on('data', data => handleData(data, peer));
        peer.on('close', () => {
             cleanupPeer(peerID);
        });
        peer.on('error', (err) => {
            console.error(`Peer error for ${peerID}:`, err);
            cleanupPeer(peerID);
        });
    }, [handleData, cleanupPeer]);

    // ================== FIX #2: Simplified and More Robust useEffect Logic ==================
    useEffect(() => {
        socketRef.current = io(API_URL);
        const socket = socketRef.current;
        setStatus('Successfully connected to the signaling server!');

        // Event for the NEW user: connect to everyone already here.
        socket.on('all users', users => {
            users.forEach(userID => {
                if (userID !== socket.id && !peersRef.current[userID]) {
                    console.log(`Initiating connection to existing user: ${userID}`);
                    const peer = new Peer({ initiator: true, trickle: false, ...peerConfig });
                    peer.on('signal', signal => {
                        socket.emit('sending signal', { userToSignal: userID, callerID: socket.id, signal });
                    });
                    setupPeerEvents(peer, userID);
                    peersRef.current[userID] = peer;
                }
            });
        });

        // Event for EXISTING users: a new user has signaled them.
        socket.on('signal received', payload => {
            if (peersRef.current[payload.callerID]) {
                // If a peer object already exists, just signal it.
                console.log(`Completing connection with ${payload.callerID}`);
                peersRef.current[payload.callerID].signal(payload.signal);
            } else {
                // Otherwise, create a new peer to answer.
                console.log(`Answering connection from new user: ${payload.callerID}`);
                const peer = new Peer({ initiator: false, trickle: false, ...peerConfig });
                peer.on('signal', signal => {
                    socket.emit('returning signal', { signal, callerID: payload.callerID });
                });
                peer.signal(payload.signal);
                setupPeerEvents(peer, payload.callerID);
                peersRef.current[payload.callerID] = peer;
            }
        });

        // Event for an INITIATOR who gets a signal back.
        socket.on('signal returned', payload => {
            if (peersRef.current[payload.id]) {
                peersRef.current[payload.id].signal(payload.signal);
            }
        });
        
        socket.on('user left', userID => {
            cleanupPeer(userID);
        });
        
        // No 'user joined' handler is needed, as the initiator ('all users') / answer ('signal received') flow covers all cases.

        return () => {
            socket.disconnect();
            Object.values(peersRef.current).forEach(peer => peer.destroy());
        };
    }, [setupPeerEvents, cleanupPeer]); 
    
    function handleFileSelect(e) {
        const file = e.target.files[0];
        if (!file) return;
        
        const updatedFiles = { ...myFilesRef.current, [file.name]: file };
        setMyFiles(updatedFiles);

        // ================== FIX #3: Always send the full file list for consistency ==================
        const fullFileList = Object.values(updatedFiles).map(f => ({ name: f.name, size: f.size }));

        Object.values(peersRef.current).forEach(peer => {
            if (peer && peer.connected) {
                peer.send(JSON.stringify({ type: 'file-list', files: fullFileList }));
            }
        });
        e.target.value = '';
    }
    
    function requestFile(fileName) {
        currentlyReceivingFile.current = fileName;
        fileChunksRef.current[fileName] = { chunks: [] };
        const fileInfo = Object.values(peerFiles).find(f => f.name === fileName);
        const peer = fileInfo ? peersRef.current[fileInfo.peer] : null;

        if (peer) {
            peer.send(JSON.stringify({ type: 'file-request', name: fileName }));
        } else {
            console.error("Could not find the peer who owns the file:", fileName);
        }
    }

    function sendFile(file, peer) {
        const chunkSize = 64 * 1024;
        const reader = new FileReader();
        let offset = 0;
        reader.onload = (e) => {
            if (!e.target.error) {
                peer.send(e.target.result);
                offset += e.target.result.byteLength;
                if (offset < file.size) {
                    readSlice(offset);
                } else {
                    peer.send(JSON.stringify({ type: 'file-done', name: file.name }));
                }
            }
        };
        const readSlice = o => {
            const slice = file.slice(o, o + chunkSize);
            reader.readAsArrayBuffer(slice);
        };
        readSlice(0);
    }
    
    return (
        <div className="App">
            <header className="App-header">
                <h1>Peer-to-Peer File Sharer</h1>
                <p>Status: <strong>{status}</strong></p>
                <div className="file-container">
                    <div className="my-files">
                        <h2>My Shareable Files</h2>
                        <input type="file" onChange={handleFileSelect} />
                        <ul>
                            {Object.values(myFiles).map(file => <li key={file.name}>{file.name} ({(file.size / 1024).toFixed(2)} KB)</li>)}
                        </ul>
                    </div>
                    <div className="peer-files">
                        <h2>Available on Network</h2>
                        <ul>
                            {Object.values(peerFiles).map(file => <li key={file.name}>{file.name} <button onClick={() => requestFile(file.name)}>Download</button></li>)}
                        </ul>
                    </div>
                </div>
            </header>
        </div>
    );
}

export default App;

