import React, { useEffect, useState, useRef } from 'react';
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

    // Use a ref for myFiles to be accessible in closures without dependency issues
    const myFilesRef = useRef(myFiles);
    myFilesRef.current = myFiles;

    useEffect(() => {
        setStatus('Connecting to signaling server...');
        socketRef.current = io(API_URL);

        const peerConfig = { config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] } };

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

        const handleData = (data, peerID) => {
            if (typeof data === 'string') {
                try {
                    const message = JSON.parse(data);
                    if (message.type === 'file-list') {
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
                } catch (e) {
                    // This is the critical fix: Log the error instead of swallowing it.
                    console.error("Failed to parse message or handle data:", e, "Raw data:", data);
                }
            } else {
                const fileName = Object.keys(fileChunksRef.current).find(key => fileChunksRef.current[key].receiving);
                if (fileName) {
                    fileChunksRef.current[fileName].chunks.push(data);
                }
            }
        };

        const setupPeerEvents = (peer, peerID) => {
            setStatus(`Connected to a peer! Ready to share.`);
            peer.on('data', data => handleData(data, peerID));
            peer.on('error', err => console.error(`ERROR: Peer ${peerID} error:`, err));
            peer.on('close', () => {
                setStatus("A peer has left the network.");
                delete peersRef.current[peerID];
                setPeerFiles({}); // For simplicity, clear all files when a peer leaves
            });
            setTimeout(() => {
                const fileList = Object.values(myFilesRef.current).map(f => ({ name: f.name, size: f.size }));
                if (fileList.length > 0 && peer.connected) {
                    peer.send(JSON.stringify({ type: 'file-list', files: fileList }));
                }
            }, 500);
        };

        const createPeer = (userToSignal, callerID) => {
            const peer = new Peer({ initiator: true, trickle: false, ...peerConfig });
            peer.on('signal', signal => socketRef.current.emit('sending signal', { userToSignal, callerID, signal }));
            peer.on('connect', () => setupPeerEvents(peer, userToSignal));
            return peer;
        };

        const addPeer = (incomingSignal, callerID) => {
            const peer = new Peer({ initiator: false, trickle: false, ...peerConfig });
            peer.on('signal', signal => socketRef.current.emit('returning signal', { signal, callerID }));
            peer.on('connect', () => setupPeerEvents(peer, callerID));
            peer.signal(incomingSignal);
            return peer;
        };

        socketRef.current.on('connect', () => setStatus('Successfully connected to the signaling server!'));
        socketRef.current.on("all users", users => {
            setStatus("Network active. Connecting to peers...");
            users.forEach(userID => {
                peersRef.current[userID] = createPeer(userID, socketRef.current.id);
            });
        });
        socketRef.current.on("signal received", payload => {
            peersRef.current[payload.callerID] = addPeer(payload.signal, payload.callerID);
        });
        socketRef.current.on("signal returned", payload => {
            peersRef.current[payload.id]?.signal(payload.signal);
        });
        
        return () => {
            if (socketRef.current) socketRef.current.disconnect();
            Object.values(peersRef.current).forEach(peer => peer.destroy());
        };
    }, []); // Empty dependency array ensures this runs only once

    const handleFileSelect = (e) => {
        const file = e.target.files[0]; if (!file) return;
        const newFiles = { ...myFilesRef.current, [file.name]: file };
        myFilesRef.current = newFiles;
        setMyFiles(newFiles);
        Object.values(peersRef.current).forEach(peer => {
            if (peer.connected) {
                 peer.send(JSON.stringify({ type: 'file-list', files: [{ name: file.name, size: file.size }] }));
            }
        });
        e.target.value = '';
    };
    
    const requestFile = (fileName) => {
        fileChunksRef.current[fileName] = { chunks: [], receiving: true };
        Object.values(peersRef.current).forEach(peer => {
            if (peer.connected) {
                peer.send(JSON.stringify({ type: 'file-request', name: fileName }));
            }
        });
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