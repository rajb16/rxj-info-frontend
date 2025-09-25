import React, { useEffect, useState, useRef } from 'react';
import io from 'socket.io-client';
import Peer from 'simple-peer';
import './App.css';

const API_URL = 'https://rxj-info-api.onrender.com';

function App() {
    // State variables
    const [status, setStatus] = useState('Connecting to network...');
    const [peers, setPeers] = useState({});
    const [myFiles, setMyFiles] = useState({});
    const [peerFiles, setPeerFiles] = useState({});

    // Refs for persistent objects
    const socketRef = useRef();
    const peersRef = useRef({});
    const fileChunksRef = useRef({});

    useEffect(() => {
        setupConnections();
        return () => { // Cleanup on component unmount
            if (socketRef.current) socketRef.current.disconnect();
            Object.values(peersRef.current).forEach(peer => peer.destroy());
        };
    }, []);

    // Main setup function
    function setupConnections() {
        socketRef.current = io(API_URL);
        setStatus('Successfully connected to the signaling server!');

        socketRef.current.on('all users', users => {
            setStatus('Network active. Searching for peers...');
            users.forEach(userID => {
                const peer = createPeer(userID, socketRef.current.id);
                peersRef.current[userID] = peer;
                setPeers(prev => ({ ...prev, [userID]: peer }));
            });
        });

        socketRef.current.on('user joined', payload => {
            setStatus('A new peer joined! Connecting...');
            const peer = addPeer(payload.signal, payload.callerID);
            peersRef.current[payload.callerID] = peer;
            setPeers(prev => ({ ...prev, [payload.callerID]: peer }));
        });

        socketRef.current.on('signal returned', payload => {
            peersRef.current[payload.id]?.signal(payload.signal);
        });
    }

    // Function to create a new peer connection (for the initiator)
    function createPeer(userToSignal, callerID) {
        const peer = new Peer({ initiator: true, trickle: false });
        peer.on('signal', signal => socketRef.current.emit('sending signal', { userToSignal, callerID, signal }));
        peer.on('connect', () => setupPeerEvents(peer));
        return peer;
    }

    // Function to add a new peer connection (for the receiver)
    function addPeer(incomingSignal, callerID) {
        const peer = new Peer({ initiator: false, trickle: false });
        peer.on('signal', signal => socketRef.current.emit('returning signal', { signal, callerID }));
        peer.on('connect', () => setupPeerEvents(peer));
        peer.signal(incomingSignal);
        return peer;
    }
    
    // Setup event listeners for a connected peer
    function setupPeerEvents(peer) {
        setStatus(`Connected to a peer! Ready to share.`);
        // Broadcast your files to the newly connected peer
        peer.send(JSON.stringify({ type: 'file-list', files: Object.values(myFiles).map(f => ({ name: f.name, size: f.size })) }));

        peer.on('data', data => handleData(data, peer));
    }

    // Handle all incoming data from peers
    function handleData(data, peer) {
        try {
            const message = JSON.parse(data);
            // Handle different message types
            if (message.type === 'file-list') {
                setPeerFiles(prev => ({ ...prev, ...message.files.reduce((obj, file) => ({...obj, [file.name]: file}), {}) }));
            } else if (message.type === 'file-request') {
                sendFile(myFiles[message.name], peer);
            } else if (message.type === 'file-chunk') {
                // Receive and assemble file chunks
                if (!fileChunksRef.current[message.name]) {
                    fileChunksRef.current[message.name] = [];
                }
                fileChunksRef.current[message.name].push(message.chunk);
            } else if (message.type === 'file-done') {
                // Finalize file reception
                const completeFile = new Blob(fileChunksRef.current[message.name]);
                const url = URL.createObjectURL(completeFile);
                const a = document.createElement('a');
                a.href = url;
                a.download = message.name;
                document.body.appendChild(a);
                a.click();
                a.remove();
                delete fileChunksRef.current[message.name]; // Clean up
            }
        } catch (e) { console.error('Error handling data', e); }
    }

    // Function to handle file selection
    function handleFileSelect(e) {
        const file = e.target.files[0];
        if (!file) return;
        const fileInfo = { name: file.name, size: file.size };
        setMyFiles(prev => ({ ...prev, [file.name]: file }));
        // Broadcast the new file to all peers
        Object.values(peersRef.current).forEach(peer => {
            peer.send(JSON.stringify({ type: 'file-list', files: [fileInfo] }));
        });
        e.target.value = ''; // Reset input
    }
    
    // Function to request a file from a peer
    function requestFile(fileName) {
        Object.values(peersRef.current).forEach(peer => {
            peer.send(JSON.stringify({ type: 'file-request', name: fileName }));
        });
    }

    // Function to chunk and send a file
    function sendFile(file, peer) {
        const chunkSize = 64 * 1024; // 64KB chunks
        const reader = new FileReader();
        let offset = 0;

        reader.onload = (e) => {
            if (!e.target.error) {
                peer.send(JSON.stringify({ type: 'file-chunk', name: file.name, chunk: e.target.result }));
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