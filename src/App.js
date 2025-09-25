import React, { useEffect, useState, useRef, useCallback } from 'react';
import io from 'socket.io-client';
import Peer from 'simple-peer';
import './App.css';

const API_URL = 'https://rxj-info-api.onrender.com';

function App() {
    const [status, setStatus] = useState('Connecting to network...');
    const [myFiles, setMyFiles] = useState({});
    const [peerFiles, setPeerFiles] = useState({});
    
    // Use state only for IDs to trigger re-renders, not for the complex peer objects
    const [peerIDs, setPeerIDs] = useState([]);

    const socketRef = useRef();
    const peersRef = useRef({});
    const fileChunksRef = useRef({});

    // --- Core Handlers wrapped in useCallback for stability ---

    const handleData = useCallback((data, peerID) => {
        if (typeof data === 'string') {
            try {
                const message = JSON.parse(data);
                if (message.type === 'file-list') {
                    setPeerFiles(prev => ({ ...prev, ...message.files.reduce((obj, file) => ({...obj, [file.name]: file}), {}) }));
                } else if (message.type === 'file-request') {
                    const file = myFiles[message.name];
                    const peer = peersRef.current[peerID];
                    if (file && peer) {
                        sendFile(file, peer);
                    }
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
            } catch (e) { console.error('Error parsing JSON message: ', e); }
        } else {
            const fileName = Object.keys(fileChunksRef.current).find(key => fileChunksRef.current[key].receiving);
            if (fileName) {
                fileChunksRef.current[fileName].chunks.push(data);
            }
        }
    }, [myFiles]); // myFiles is a dependency

    const setupPeerEvents = useCallback((peer, peerID) => {
        setStatus(`Connected to a peer! Ready to share.`);
        peer.on('data', data => handleData(data, peerID));
        const fileList = Object.values(myFiles).map(f => ({ name: f.name, size: f.size }));
        if (fileList.length > 0) {
            peer.send(JSON.stringify({ type: 'file-list', files: fileList }));
        }
    }, [myFiles, handleData]);

    const addPeer = useCallback((incomingSignal, callerID) => {
        const peer = new Peer({ initiator: false, trickle: false, config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] } });
        peer.on('signal', signal => socketRef.current.emit('returning signal', { signal, callerID }));
        peer.on('connect', () => setupPeerEvents(peer, callerID));
        peer.signal(incomingSignal);
        return peer;
    }, [setupPeerEvents]);

    const createPeer = useCallback((userToSignal, callerID) => {
        const peer = new Peer({ initiator: true, trickle: false, config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] } });
        peer.on('signal', signal => socketRef.current.emit('sending signal', { userToSignal, callerID, signal }));
        peer.on('connect', () => setupPeerEvents(peer, userToSignal));
        return peer;
    }, [setupPeerEvents]);

    // --- Main useEffect for setting up socket listeners ---
    useEffect(() => {
        socketRef.current = io(API_URL);
        setStatus('Successfully connected to the signaling server!');

        socketRef.current.on("all users", users => {
            setStatus("Network active. Connecting to peers...");
            users.forEach(userID => {
                const peer = createPeer(userID, socketRef.current.id);
                peersRef.current[userID] = peer;
            });
            setPeerIDs(users);
        });

        socketRef.current.on("signal received", payload => {
            setStatus("Peer joining. Accepting connection...");
            const peer = addPeer(payload.signal, payload.callerID);
            peersRef.current[payload.callerID] = peer;
            setPeerIDs(prev => [...prev, payload.callerID]);
        });

        socketRef.current.on("signal returned", payload => {
            peersRef.current[payload.id]?.signal(payload.signal);
        });

        socketRef.current.on("user left", userID => {
            setStatus("A peer has left the network.");
            if (peersRef.current[userID]) peersRef.current[userID].destroy();
            delete peersRef.current[userID];
            setPeerIDs(prev => prev.filter(id => id !== userID));
            setPeerFiles({});
        });
        
        return () => {
            if (socketRef.current) socketRef.current.disconnect();
            Object.values(peersRef.current).forEach(peer => peer.destroy());
        };
    }, [createPeer, addPeer]);

    // --- File Handling Functions ---
    const handleFileSelect = (e) => {
        const file = e.target.files[0]; if (!file) return;
        setMyFiles(prev => ({ ...prev, [file.name]: file }));
        Object.values(peersRef.current).forEach(peer => {
            if (peer.connected) {
                 peer.send(JSON.stringify({ type: 'file-list', files: [{ name: file.name, size: file.size }] }));
            }
        });
        e.target.value = '';
    }
    
    const requestFile = (fileName) => {
        fileChunksRef.current[fileName] = { chunks: [], receiving: true };
        Object.values(peersRef.current).forEach(peer => {
            if (peer.connected) {
                peer.send(JSON.stringify({ type: 'file-request', name: fileName }));
            }
        });
    }

    const sendFile = (file, peer) => {
        const chunkSize = 64 * 1024; let offset = 0;
        const reader = new FileReader();
        reader.onload = (e) => {
            if (e.target.error) return console.error("Error reading file:", e.target.error);
            peer.send(e.target.result);
            offset += e.target.result.byteLength;
            if (offset < file.size) {
                readSlice(offset);
            } else {
                peer.send(JSON.stringify({ type: 'file-done', name: file.name }));
            }
        };
        const readSlice = o => { const slice = file.slice(o, o + chunkSize); reader.readAsArrayBuffer(slice); };
        readSlice(0);
    }
    
    // --- JSX Render ---
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