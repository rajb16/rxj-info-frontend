import React, { useEffect, useState, useRef, useCallback } from 'react';
import io from 'socket.io-client';
import Peer from 'simple-peer';
import './App.css';

const API_URL = 'https://rxj-info-api.onrender.com';

function App() {
    const [status, setStatus] = useState('Initializing...');
    const [myFiles, setMyFiles] = useState({});
    const [peerFiles, setPeerFiles] = useState({});

    const socketRef = useRef();
    const peersRef = useRef({});
    const fileChunksRef = useRef({});
    const myFilesRef = useRef(myFiles);
    myFilesRef.current = myFiles;

    const handleData = useCallback((data, peerID) => {
        if (typeof data === 'string') {
            try {
                const message = JSON.parse(data);
                if (message.type === 'file-list') {
                    setPeerFiles(prev => ({ ...prev, [peerID]: message.files }));
                } else if (message.type === 'file-request') {
                    const file = myFilesRef.current[message.name];
                    const peer = peersRef.current[peerID];
                    if (file && peer) sendFile(file, peer);
                } else if (message.type === 'file-done') {
                    const fileName = message.name;
                    const fileInfo = fileChunksRef.current[fileName];
                    if (fileInfo) {
                        const completeFile = new Blob(fileInfo.chunks);
                        const url = URL.createObjectURL(completeFile);
                        const a = document.createElement('a'); a.href = url; a.download = fileName; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
                        delete fileChunksRef.current[fileName];
                    }
                }
            } catch (e) { console.error("Failed to parse JSON message:", e); }
        } else {
            const fileName = Object.keys(fileChunksRef.current).find(key => fileChunksRef.current[key].receiving);
            if (fileName) fileChunksRef.current[fileName].chunks.push(data);
        }
    }, []);
    
    // ================== FIX #1: ROBUST CLEANUP ==================
    const cleanupPeer = useCallback((peerID) => {
        console.log(`LOG: Cleaning up resources for peer ${peerID}`);
        const peer = peersRef.current[peerID];
        if (peer) {
            peer.destroy();
            delete peersRef.current[peerID];
        }
        setPeerFiles(prev => {
            const newPeerFiles = { ...prev };
            delete newPeerFiles[peerID];
            return newPeerFiles;
        });
    }, []);

    const setupPeerEvents = useCallback((peer, peerID) => {
        console.log(`LOG: Setting up events for peer ${peerID}`);
        
        peer.on('connect', () => {
            console.log(`LOG: Connection to peer ${peerID} established!`);
            setStatus(`Connected to a peer! Ready to share.`);
            const fileList = Object.values(myFilesRef.current).map(f => ({ name: f.name, size: f.size }));
            if (fileList.length > 0) {
                console.log(`LOG: Announcing my files to the newly connected peer ${peerID}`);
                peer.send(JSON.stringify({ type: 'file-list', files: fileList }));
            }
        });

        peer.on('data', data => handleData(data, peerID));
        peer.on('error', err => {
            console.error(`ERROR: Peer ${peerID} error:`, err);
            cleanupPeer(peerID); // Clean up on error
        });
        peer.on('close', () => {
            console.log(`LOG: Peer ${peerID} connection closed.`);
            cleanupPeer(peerID); // Clean up on close
        });
    }, [handleData, cleanupPeer]);

    useEffect(() => {
        // ================== FIX #2: PREVENT RACE CONDITION ==================
        const createPeer = (userToSignal, callerID) => {
            if (peersRef.current[userToSignal]) {
                console.log(`LOG: A peer connection with ${userToSignal} already exists or is being established. Aborting creation.`);
                return;
            }
            console.log(`LOG: Creating peer to connect to: ${userToSignal}`);
            const peer = new Peer({ initiator: true, trickle: false });
            peersRef.current[userToSignal] = peer; // Store peer immediately
            peer.on('signal', signal => socketRef.current.emit('sending signal', { userToSignal, callerID, signal }));
            setupPeerEvents(peer, userToSignal);
            return peer;
        };
        const addPeer = (incomingSignal, callerID) => {
            if (peersRef.current[callerID]) {
                console.log(`LOG: Peer connection with ${callerID} already exists. Signaling existing peer.`);
                return peersRef.current[callerID].signal(incomingSignal);
            }
            console.log(`LOG: Adding peer who signaled us: ${callerID}`);
            const peer = new Peer({ initiator: false, trickle: false });
            peersRef.current[callerID] = peer; // Store peer immediately
            peer.on('signal', signal => socketRef.current.emit('returning signal', { signal, callerID }));
            peer.signal(incomingSignal);
            setupPeerEvents(peer, callerID);
            return peer;
        };
        socketRef.current = io(API_URL);
        socketRef.current.on('connect', () => setStatus('Successfully connected to the signaling server!'));
        socketRef.current.on("all users", users => {
            users.forEach(userID => { createPeer(userID, socketRef.current.id); });
        });
        socketRef.current.on('user joined', userID => {
            createPeer(userID, socketRef.current.id);
        });
        socketRef.current.on("signal received", payload => {
            addPeer(payload.signal, payload.callerID);
        });
        socketRef.current.on("signal returned", payload => {
            peersRef.current[payload.id]?.signal(payload.signal);
        });

        // Add listener for server-side disconnect event
        socketRef.current.on('user left', userID => {
            console.log(`LOG: Server reports that peer ${userID} has left.`);
            cleanupPeer(userID);
        });

        return () => {
            if (socketRef.current) socketRef.current.disconnect();
            Object.values(peersRef.current).forEach(peer => peer.destroy());
        };
    }, [setupPeerEvents, cleanupPeer]);
    
    const handleFileSelect = (e) => {
        const file = e.target.files[0]; if (!file) return;
        
        const updatedFiles = { ...myFilesRef.current, [file.name]: file };
        setMyFiles(updatedFiles);

        const fileList = Object.values(updatedFiles).map(f => ({ name: f.name, size: f.size }));
        
        console.log("LOG: Announcing updated file list to all connected peers.");
        Object.values(peersRef.current).forEach(peer => {
            if (peer.connected) {
                 peer.send(JSON.stringify({ type: 'file-list', files: fileList }));
            }
        });
        e.target.value = '';
    };
    
    const requestFile = (fileName, peerID) => {
        fileChunksRef.current[fileName] = { chunks: [], receiving: true };
        const peer = peersRef.current[peerID];
        if (peer && peer.connected) {
            peer.send(JSON.stringify({ type: 'file-request', name: fileName }));
        }
    };
    const sendFile = (file, peer) => {
        const chunkSize = 64 * 1024; let offset = 0;
        const reader = new FileReader();
        reader.onload = (event) => {
            if (event.target.error) return console.error("Error reading file:", event.target.error);
            peer.send(event.target.result);
            offset += event.target.result.byteLength;
            if (offset < file.size) {
                readSlice(offset);
            } else {
                peer.send(JSON.stringify({ type: 'file-done', name: file.name }));
            }
        };
        const readSlice = o => { const slice = file.slice(o, o + chunkSize); reader.readAsArrayBuffer(slice); };
        readSlice(0);
    };
    
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
                           {Object.entries(peerFiles).flatMap(([peerID, files]) => 
                                (files || []).map(file => (
                                    <li key={`${peerID}-${file.name}`}>
                                        {file.name} 
                                        <button onClick={() => requestFile(file.name, peerID)}>Download</button>
                                    </li>
                                ))
                            )}
                        </ul>
                    </div>
                </div>
            </header>
        </div>
    );
}

export default App;

