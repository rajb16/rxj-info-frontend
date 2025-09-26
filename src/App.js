import React, { useEffect, useState, useRef, useCallback } from 'react';
import io from 'socket.io-client';
import Peer from 'simple-peer';
import './App.css';

const API_URL = 'https://rxj-info-api.onrender.com';

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

    useEffect(() => {
        socketRef.current = io(API_URL);
        setStatus('Successfully connected to the signaling server!');

        const createPeer = (userToSignal, callerID) => {
            if (peersRef.current[userToSignal]) {
                console.log(`Connection with ${userToSignal} already exists.`);
                return peersRef.current[userToSignal];
            }
            const peer = new Peer({ initiator: true, trickle: false });
            peer.on('signal', signal => socketRef.current.emit('sending signal', { userToSignal, callerID, signal }));
            setupPeerEvents(peer, userToSignal);
            return peer;
        }

        const addPeer = (callerID, incomingSignal) => {
             if (peersRef.current[callerID]) {
                console.log(`Answering existing peer ${callerID}`);
                peersRef.current[callerID].signal(incomingSignal);
                return peersRef.current[callerID];
            }
            const peer = new Peer({ initiator: false, trickle: false });
            peer.on('signal', signal => socketRef.current.emit('returning signal', { signal, callerID }));
            peer.signal(incomingSignal);
            setupPeerEvents(peer, callerID);
            return peer;
        }

        // Event for the NEW user: connect to everyone already here.
        socketRef.current.on('all users', users => {
            users.forEach(userID => {
                if (userID !== socketRef.current.id) {
                    peersRef.current[userID] = createPeer(userID, socketRef.current.id);
                }
            });
        });

        // ================== THIS IS THE MAIN FIX ==================
        // Event for EXISTING users: a new user has joined.
        // We simply log this and wait for the new user's signal. We DO NOT initiate a connection here.
        socketRef.current.on('user joined', userID => {
            console.log(`A new user joined: ${userID}. Waiting for their signal.`);
        });
        
        // An existing user receives a signal from a new user. Now we create our peer to answer.
        socketRef.current.on('signal received', payload => {
             peersRef.current[payload.callerID] = addPeer(payload.callerID, payload.signal);
        });

        // A new user (initiator) gets the signal back from an existing user.
        socketRef.current.on('signal returned', payload => {
            peersRef.current[payload.id]?.signal(payload.signal);
        });
        
        socketRef.current.on('user left', userID => {
            cleanupPeer(userID);
        });

        return () => {
            socketRef.current.disconnect();
            Object.values(peersRef.current).forEach(peer => peer.destroy());
        };
    }, [setupPeerEvents, cleanupPeer]); 
    
    function handleFileSelect(e) {
        const file = e.target.files[0];
        if (!file) return;
        setMyFiles(prev => ({ ...prev, [file.name]: file }));
        const fileInfo = { name: file.name, size: file.size };
        Object.values(peersRef.current).forEach(peer => {
            // Add a check to make sure the peer exists and is connected before sending
            if (peer && peer.connected) {
                peer.send(JSON.stringify({ type: 'file-list', files: [fileInfo] }));
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

