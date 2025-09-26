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

    const cleanupPeer = useCallback((peerID) => {
        console.log(`LOG: Cleaning up resources for peer ${peerID}`);
        if (peersRef.current[peerID]) {
            peersRef.current[peerID].destroy();
            delete peersRef.current[peerID];
        }
        setPeerFiles(prev => {
            const newPeerFiles = { ...prev };
            delete newPeerFiles[peerID];
            return newPeerFiles;
        });
    }, []);

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

    const setupPeerEvents = useCallback((peer, peerID) => {
        peer.on('connect', () => {
            setStatus(`Connected to a peer! Ready to share.`);
            const fileList = Object.values(myFilesRef.current).map(f => ({ name: f.name, size: f.size }));
            peer.send(JSON.stringify({ type: 'file-list', files: fileList }));
        });
        peer.on('data', (data) => handleData(data, peerID));
        peer.on('error', (err) => {
            console.error(`ERROR in peer ${peerID}:`, err);
            cleanupPeer(peerID);
        });
        peer.on('close', () => {
            console.log(`Peer ${peerID} connection closed.`);
            cleanupPeer(peerID);
        });
    }, [handleData, cleanupPeer]);


    useEffect(() => {
        socketRef.current = io(API_URL);
        const socket = socketRef.current;

        const createPeer = (userToSignal, callerID) => {
            const peer = new Peer({ initiator: true, trickle: false });
            peer.on('signal', signal => {
                socket.emit('sending signal', { userToSignal, callerID, signal });
            });
            setupPeerEvents(peer, userToSignal);
            return peer;
        }

        const addPeer = (incomingSignal, callerID) => {
            const peer = new Peer({ initiator: false, trickle: false });
            peer.on('signal', signal => {
                socket.emit('returning signal', { signal, callerID });
            });
            peer.signal(incomingSignal);
            setupPeerEvents(peer, callerID);
            return peer;
        }

        socket.on('connect', () => {
            setStatus('Successfully connected to the signaling server!');
        });

        socket.on('all users', users => {
            console.log("LOG: All users event", users);
            users.forEach(userID => {
                if (userID !== socket.id && !peersRef.current[userID]) {
                    const peer = createPeer(userID, socket.id);
                    peersRef.current[userID] = peer;
                }
            });
        });

        socket.on('user joined', userID => {
            console.log("LOG: User joined event", userID);
             if (!peersRef.current[userID]) {
                const peer = createPeer(userID, socket.id);
                peersRef.current[userID] = peer;
            }
        });

        socket.on('signal received', payload => {
            console.log("LOG: Signal received event", payload.callerID);
            if (!peersRef.current[payload.callerID]) {
                const peer = addPeer(payload.signal, payload.callerID);
                peersRef.current[payload.callerID] = peer;
            }
        });

        socket.on('signal returned', payload => {
            console.log("LOG: Signal returned event", payload.id);
            const peer = peersRef.current[payload.id];
            if (peer) {
                peer.signal(payload.signal);
            }
        });
        
        socket.on('user left', cleanupPeer);

        return () => {
            socket.disconnect();
            Object.values(peersRef.current).forEach(peer => peer.destroy());
        };
    }, [setupPeerEvents, cleanupPeer]);
    
    const handleFileSelect = (e) => {
        const file = e.target.files[0]; if (!file) return;
        const updatedFiles = { ...myFilesRef.current, [file.name]: file };
        myFilesRef.current = updatedFiles;
        setMyFiles(updatedFiles);

        const fileList = Object.values(updatedFiles).map(f => ({ name: f.name, size: f.size }));
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

