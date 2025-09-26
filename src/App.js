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
        console.log(`LOG: Received data from peer ${peerID}.`);
        if (typeof data === 'string') {
            try {
                const message = JSON.parse(data);
                console.log("LOG: Parsed message:", message);
                if (message.type === 'file-list') {
                    // FIX: This logic is now safer. It merges new files with existing ones.
                    setPeerFiles(prev => ({ ...prev, ...message.files.reduce((obj, file) => ({...obj, [file.name]: file}), {}) }));
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
                        const a = document.createElement('a'); a.href = url; a.download = fileName; document.body.appendChild(a); a.click(); a.remove();
                        delete fileChunksRef.current[fileName];
                    }
                }
            } catch (e) { console.error("Failed to parse JSON message:", e, "Raw data:", data); }
        } else {
            const fileName = Object.keys(fileChunksRef.current).find(key => fileChunksRef.current[key].receiving);
            if (fileName) {
                console.log(`LOG: It's a file chunk for: ${fileName}`);
                fileChunksRef.current[fileName].chunks.push(data);
            }
        }
    }, []);

    const setupPeerEvents = useCallback((peer, peerID) => {
        console.log(`LOG: Setting up events for peer ${peerID}`);
        setStatus(`Connected to a peer! Ready to share.`);
        peer.on('data', data => handleData(data, peerID));
        peer.on('error', err => console.error(`ERROR: Peer ${peerID} error:`, err));
        peer.on('close', () => {
            console.log(`LOG: Peer ${peerID} connection closed.`);
            setStatus("A peer has left the network.");
            delete peersRef.current[peerID];
            // FIX: More robust cleanup is needed, but for now, we'll just remove the peer
            // to prevent errors. We can improve this later.
        });
        setTimeout(() => {
            const fileList = Object.values(myFilesRef.current).map(f => ({ name: f.name, size: f.size }));
            if (fileList.length > 0 && peer.connected) {
                console.log(`LOG: Announcing my existing files to new peer ${peerID}`);
                peer.send(JSON.stringify({ type: 'file-list', files: fileList }));
            }
        }, 500);
    }, [handleData]);

    useEffect(() => {
        const peerConfig = { config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] } };

        const createPeer = (userToSignal, callerID) => {
            if (peersRef.current[userToSignal]) {
                console.log("LOG: Connection already exists or is being established with", userToSignal);
                return peersRef.current[userToSignal];
            }
            console.log(`LOG: Creating peer to connect to: ${userToSignal}`);
            const peer = new Peer({ initiator: true, trickle: false, ...peerConfig });
            peer.on('signal', signal => socketRef.current.emit('sending signal', { userToSignal, callerID, signal }));
            peer.on('connect', () => setupPeerEvents(peer, userToSignal));
            peersRef.current[userToSignal] = peer; // Store the peer immediately
            return peer;
        };
        const addPeer = (incomingSignal, callerID) => {
             if (peersRef.current[callerID]) {
                console.log("LOG: Connection already exists. Signaling peer.", callerID);
                return peersRef.current[callerID].signal(incomingSignal);
            }
            console.log(`LOG: Adding peer who signaled us: ${callerID}`);
            const peer = new Peer({ initiator: false, trickle: false, ...peerConfig });
            peer.on('signal', signal => socketRef.current.emit('returning signal', { signal, callerID }));
            peer.on('connect', () => setupPeerEvents(peer, callerID));
            peer.signal(incomingSignal);
            peersRef.current[callerID] = peer; // Store the peer immediately
            return peer;
        };

        socketRef.current = io(API_URL);
        socketRef.current.on('connect', () => setStatus('Successfully connected to the signaling server!'));
        
        // This is for the NEW user joining the network
        socketRef.current.on("all users", users => {
            console.log("LOG: Network has existing users:", users);
            users.forEach(userID => { createPeer(userID, socketRef.current.id); });
        });
        
        // ================== FIX STARTS HERE ==================
        // This is for users ALREADY on the network
        socketRef.current.on('user joined', userID => {
            console.log(`LOG: A new user joined: ${userID}. Connecting to them.`);
            createPeer(userID, socketRef.current.id);
        });
        // =================== FIX ENDS HERE ===================

        socketRef.current.on("signal received", payload => {
            addPeer(payload.signal, payload.callerID);
        });
        socketRef.current.on("signal returned", payload => {
            peersRef.current[payload.id]?.signal(payload.signal);
        });
        
        return () => {
            if (socketRef.current) socketRef.current.disconnect();
            Object.values(peersRef.current).forEach(peer => peer.destroy());
        };
    }, [setupPeerEvents]);
    
    // Unchanged functions: handleFileSelect, requestFile, sendFile, and the component return
    const handleFileSelect = (e) => {
        const file = e.target.files[0]; if (!file) return;
        const newFiles = { ...myFilesRef.current, [file.name]: file };
        myFilesRef.current = newFiles;
        setMyFiles(newFiles);
        console.log("LOG: Announcing new file to all peers:", file.name);
        Object.values(peersRef.current).forEach(peer => {
            if (peer.connected) {
                 peer.send(JSON.stringify({ type: 'file-list', files: [{ name: file.name, size: file.size }] }));
            } else {
                console.log("LOG: Did not send to a peer because it was not connected.");
            }
        });
        e.target.value = '';
    };
    
    const requestFile = (fileName) => {
        console.log(`LOG: [You clicked] Requesting to download file: ${fileName}`);
        fileChunksRef.current[fileName] = { chunks: [], receiving: true };
        Object.values(peersRef.current).forEach(peer => {
            if (peer.connected) {
                peer.send(JSON.stringify({ type: 'file-request', name: fileName }));
            }
        });
    };

    const sendFile = (file, peer) => {
        console.log(`LOG: Preparing to send ${file.name} to a peer.`);
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
                            {Object.values(peerFiles).map(file => <li key={file.name}>{file.name} <button onClick={() => requestFile(file.name)}>Download</button></li>)}
                        </ul>
                    </div>
                </div>
            </header>
        </div>
    );
}

export default App;