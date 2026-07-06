const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static assets from the current directory
app.use(express.static(__dirname));

// Persistent leaderboard
const leaderboardFile = path.join(__dirname, 'leaderboard.json');
let leaderboard = {};

function loadLeaderboard() {
    if (fs.existsSync(leaderboardFile)) {
        try {
            const data = fs.readFileSync(leaderboardFile, 'utf8');
            leaderboard = JSON.parse(data);
            console.log('Leaderboard loaded successfully.');
        } catch (e) {
            console.error('Error parsing leaderboard.json, starting fresh:', e);
            leaderboard = {};
        }
    } else {
        leaderboard = {};
    }
}

function saveLeaderboard() {
    try {
        fs.writeFileSync(leaderboardFile, JSON.stringify(leaderboard, null, 2), 'utf8');
        console.log('Leaderboard saved to disk.');
    } catch (e) {
        console.error('Error saving leaderboard.json:', e);
    }
}

// Load ranking at startup
loadLeaderboard();

// Game state
const clients = {}; // playerId -> ws
const players = {}; // playerId -> player state/info
const races = {};   // raceId -> race room state
let nextPlayerId = 1;

wss.on('connection', (ws) => {
    const playerId = nextPlayerId++;
    ws.playerId = playerId;
    clients[playerId] = ws;
    
    // Register initial player state (menu)
    players[playerId] = {
        id: playerId,
        name: `Piloto_${playerId}`,
        color: '#1e90ff',
        raceId: null,
        state: 'menu'
    };

    console.log(`Player connected, assigned ID: ${playerId}`);

    // Send the current leaderboard and assigned ID upon connection
    ws.send(JSON.stringify({
        type: 'connection_established',
        playerId: playerId,
        leaderboard: leaderboard
    }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            // --- FIND AN EXISTING RACE LOBBY ---
            if (data.type === 'find_race') {
                let foundRace = null;
                for (const rId in races) {
                    const r = races[rId];
                    if (r.status === 'waiting' && r.players.length < r.settings.maxPlayers) {
                        foundRace = r;
                        break;
                    }
                }
                
                if (foundRace) {
                    ws.send(JSON.stringify({
                        type: 'race_found',
                        raceId: foundRace.id,
                        track: foundRace.track,
                        settings: foundRace.settings
                    }));
                } else {
                    ws.send(JSON.stringify({
                        type: 'no_race_found'
                    }));
                }
            } 
            
            // --- CREATE A NEW RACE LOBBY ---
            else if (data.type === 'create_race') {
                const raceId = `race_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
                races[raceId] = {
                    id: raceId,
                    creatorId: playerId,
                    track: data.track, // { trackConfig, controlPoints }
                    settings: {
                        minPlayers: Math.max(2, parseInt(data.settings.minPlayers) || 2),
                        maxPlayers: Math.max(2, parseInt(data.settings.maxPlayers) || 4),
                        laps: Math.max(1, parseInt(data.settings.laps) || 3)
                    },
                    players: [], // player IDs
                    status: 'waiting', // waiting, countdown, racing, finished
                    countdownTimer: null,
                    countdownValue: 10,
                    lobbyTimer: null,
                    lobbyTimerValue: 60,
                    finishers: [], // array of { playerId, name, time }
                    startedPlayersCount: 0
                };
                
                console.log(`Race created: ${raceId} by Creator ${playerId}. Min: ${races[raceId].settings.minPlayers}, Max: ${races[raceId].settings.maxPlayers}`);
                
                ws.send(JSON.stringify({
                    type: 'race_created',
                    raceId: raceId,
                    track: races[raceId].track,
                    settings: races[raceId].settings
                }));
            }
            
            // --- JOIN LOBBY WITH COCHE CONFIG & START WAITING ---
            else if (data.type === 'join_lobby') {
                const raceId = data.raceId;
                const race = races[raceId];
                
                if (!race) {
                    ws.send(JSON.stringify({ type: 'error', message: 'La carrera especificada ya no existe.' }));
                    return;
                }
                
                if (race.status !== 'waiting' && race.status !== 'countdown') {
                    ws.send(JSON.stringify({ type: 'error', message: 'La carrera ya ha comenzado.' }));
                    return;
                }
                
                if (race.players.length >= race.settings.maxPlayers && !race.players.includes(playerId)) {
                    ws.send(JSON.stringify({ type: 'error', message: 'La sala de carrera está llena.' }));
                    return;
                }
                
                // Update player info
                players[playerId] = {
                    id: playerId,
                    name: data.name || `Piloto_${playerId}`,
                    color: data.color || '#1e90ff',
                    carConfig: data.carConfig || {},
                    raceId: raceId,
                    state: 'waiting',
                    x: 0, y: 0, z: 0,
                    rx: 0, ry: 0, rz: 0,
                    speed: 0
                };
                
                if (!race.players.includes(playerId)) {
                    race.players.push(playerId);
                }
                
                console.log(`Player ${players[playerId].name} joined lobby for race ${raceId}`);
                
                // Broadcast lobby updates to everyone in the race
                const lobbyPlayers = getRacePlayers(raceId);
                broadcastToRace(raceId, {
                    type: 'lobby_update',
                    players: lobbyPlayers,
                    settings: race.settings
                });
                
                // If this is the first waiting player, start the 1-minute lobby timeout
                if (race.players.length === 1) {
                    startLobbyTimer(raceId);
                }
                
                // Check if we reached the minimum players
                if (race.players.length >= race.settings.minPlayers) {
                    if (race.status === 'waiting') {
                        startRaceCountdown(raceId);
                    }
                }
            }
            
            // --- LIVE UPDATE CAR POSITION (DURING RACE) ---
            else if (data.type === 'update') {
                const p = players[playerId];
                if (p && p.raceId && p.state === 'racing') {
                    p.x = data.x;
                    p.y = data.y;
                    p.z = data.z;
                    p.rx = data.rx;
                    p.ry = data.ry;
                    p.rz = data.rz;
                    p.speed = data.speed;
                    
                    // Broadcast position update to all other players in the same race
                    broadcastToRace(p.raceId, {
                        type: 'state',
                        id: playerId,
                        player: {
                            x: p.x, y: p.y, z: p.z,
                            rx: p.rx, ry: p.ry, rz: p.rz,
                            speed: p.speed
                        }
                    }, playerId);
                }
            }
            
            // --- LAP COMPLETED ---
            else if (data.type === 'lap_completed') {
                const p = players[playerId];
                if (p && p.raceId && p.state === 'racing') {
                    broadcastToRace(p.raceId, {
                        type: 'opponent_lap',
                        id: playerId,
                        name: p.name,
                        lap: data.lap
                    }, playerId);
                }
            }
            
            // --- RACE FINISHED FOR A PLAYER ---
            else if (data.type === 'race_finished') {
                const p = players[playerId];
                if (p && p.raceId && p.state === 'racing') {
                    const race = races[p.raceId];
                    if (race) {
                        p.state = 'finished';
                        
                        // Register finisher
                        const finishRecord = {
                            playerId: playerId,
                            name: p.name,
                            time: data.time
                        };
                        race.finishers.push(finishRecord);
                        
                        console.log(`Player ${p.name} finished race ${p.raceId} in ${data.time} seconds.`);
                        
                        // Broadcast completion to all players in the race
                        broadcastToRace(p.raceId, {
                            type: 'player_finished',
                            id: playerId,
                            name: p.name,
                            time: data.time,
                            position: race.finishers.length
                        });
                        
                        // Check if all players in the race have finished or left
                        const activePlayers = race.players.filter(pId => players[pId] && players[pId].state !== 'menu');
                        const finishedCount = activePlayers.filter(pId => players[pId].state === 'finished').length;
                        
                        if (finishedCount >= activePlayers.length) {
                            endRace(p.raceId);
                        }
                    }
                }
            }
            
            // --- ABANDON LOBBY OR ACTIVE RACE ---
            else if (data.type === 'leave_race') {
                handlePlayerLeaving(playerId);
            }
            
        } catch (e) {
            console.error('Error handling WebSocket message:', e);
        }
    });

    ws.on('close', () => {
        console.log(`Player disconnected, ID: ${playerId}`);
        handlePlayerLeaving(playerId);
        delete clients[playerId];
        delete players[playerId];
    });
});

// Helper to get player data in a race
function getRacePlayers(raceId) {
    const race = races[raceId];
    if (!race) return [];
    return race.players.map(pId => {
        const p = players[pId];
        return p ? { id: p.id, name: p.name, color: p.color, state: p.state } : null;
    }).filter(Boolean);
}

// Helper to broadcast to a specific race
function broadcastToRace(raceId, obj, excludeId = null) {
    const race = races[raceId];
    if (!race) return;
    const msg = JSON.stringify(obj);
    race.players.forEach((pId) => {
        if (excludeId !== null && pId === excludeId) return;
        const client = clients[pId];
        if (client && client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    });
}

// Helper to broadcast to all connected clients
function broadcastToAll(obj) {
    const msg = JSON.stringify(obj);
    Object.values(clients).forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    });
}

// Lobby timers
function startLobbyTimer(raceId) {
    const race = races[raceId];
    if (!race) return;
    
    if (race.lobbyTimer) clearInterval(race.lobbyTimer);
    
    race.lobbyTimerValue = 60;
    broadcastToRace(raceId, { type: 'lobby_timer', value: race.lobbyTimerValue });
    
    race.lobbyTimer = setInterval(() => {
        if (!races[raceId]) {
            clearInterval(race.lobbyTimer);
            return;
        }
        
        race.lobbyTimerValue--;
        broadcastToRace(raceId, { type: 'lobby_timer', value: race.lobbyTimerValue });
        
        if (race.lobbyTimerValue <= 0) {
            clearInterval(race.lobbyTimer);
            race.lobbyTimer = null;
            
            console.log(`Race lobby ${raceId} timed out: insufficient players.`);
            broadcastToRace(raceId, { type: 'race_cancelled', reason: 'timeout' });
            
            // Clean up players in race
            race.players.forEach((pId) => {
                if (players[pId]) {
                    players[pId].raceId = null;
                    players[pId].state = 'menu';
                }
            });
            delete races[raceId];
        }
    }, 1000);
}

function startRaceCountdown(raceId) {
    const race = races[raceId];
    if (!race) return;
    
    // Stop lobby wait timer
    if (race.lobbyTimer) {
        clearInterval(race.lobbyTimer);
        race.lobbyTimer = null;
    }
    
    race.status = 'countdown';
    race.countdownValue = 10;
    console.log(`Starting countdown for race ${raceId}: 10 seconds.`);
    
    broadcastToRace(raceId, { type: 'lobby_countdown', value: race.countdownValue });
    
    race.countdownTimer = setInterval(() => {
        if (!races[raceId]) {
            clearInterval(race.countdownTimer);
            return;
        }
        
        race.countdownValue--;
        broadcastToRace(raceId, { type: 'lobby_countdown', value: race.countdownValue });
        
        if (race.countdownValue <= 0) {
            clearInterval(race.countdownTimer);
            race.countdownTimer = null;
            
            // Start the race!
            startRace(raceId);
        }
    }, 1000);
}

function cancelRaceCountdown(raceId) {
    const race = races[raceId];
    if (!race) return;
    
    if (race.countdownTimer) {
        clearInterval(race.countdownTimer);
        race.countdownTimer = null;
    }
    
    race.status = 'waiting';
    console.log(`Countdown cancelled for race ${raceId}: player count dropped below minimum.`);
    broadcastToRace(raceId, { type: 'lobby_countdown_cancelled' });
    
    // Restart wait timer
    startLobbyTimer(raceId);
}

function startRace(raceId) {
    const race = races[raceId];
    if (!race) return;
    
    race.status = 'racing';
    race.startedPlayersCount = race.players.length;
    race.finishers = [];
    
    console.log(`Race ${raceId} is starting now with ${race.startedPlayersCount} racers.`);
    
    const startingGrid = race.players.map((pId) => {
        const p = players[pId];
        if (p) {
            p.state = 'racing';
        }
        return {
            id: pId,
            name: p ? p.name : `Piloto_${pId}`,
            color: p ? p.color : '#1e90ff'
        };
    });
    
    broadcastToRace(raceId, {
        type: 'race_start',
        startingGrid: startingGrid,
        settings: race.settings,
        track: race.track
    });
}

function endRace(raceId) {
    const race = races[raceId];
    if (!race) return;
    
    race.status = 'finished';
    console.log(`Race ${raceId} ended. Distributing points.`);
    
    const totalRacers = race.startedPlayersCount || race.players.length;
    const raceResults = [];
    
    // Calculate points for finishers
    race.finishers.forEach((f, idx) => {
        const points = Math.max(1, totalRacers - idx);
        
        // Update persistent leaderboard
        if (!leaderboard[f.name]) {
            leaderboard[f.name] = 0;
        }
        leaderboard[f.name] += points;
        
        raceResults.push({
            name: f.name,
            time: f.time,
            points: points,
            dnf: false
        });
    });
    
    // Identify any remaining players who did not finish (DNF)
    race.players.forEach((pId) => {
        const p = players[pId];
        if (p && p.state !== 'menu' && !race.finishers.some(f => f.playerId === pId)) {
            raceResults.push({
                name: p.name,
                time: null,
                points: 0,
                dnf: true
            });
        }
    });
    
    // Save updated leaderboard to disk
    saveLeaderboard();
    
    // Broadcast leaderboard update to everyone on the server
    broadcastToAll({
        type: 'leaderboard',
        leaderboard: leaderboard
    });
    
    // Send final results to players in this race
    broadcastToRace(raceId, {
        type: 'race_results',
        results: raceResults
    });
    
    // Clean up lobby resources after 20 seconds
    setTimeout(() => {
        if (races[raceId]) {
            races[raceId].players.forEach((pId) => {
                const p = players[pId];
                if (p && p.raceId === raceId) {
                    p.raceId = null;
                    p.state = 'menu';
                }
            });
            delete races[raceId];
            console.log(`Race room ${raceId} cleaned up.`);
        }
    }, 20000);
}

function handlePlayerLeaving(playerId) {
    const p = players[playerId];
    if (!p || !p.raceId) return;
    
    const raceId = p.raceId;
    const race = races[raceId];
    p.raceId = null;
    p.state = 'menu';
    
    if (race) {
        // Remove from players array
        race.players = race.players.filter(pId => pId !== playerId);
        console.log(`Player ${p.name || playerId} left race ${raceId}.`);
        
        // Notify others
        broadcastToRace(raceId, {
            type: 'player_left',
            id: playerId,
            name: p.name
        });
        
        // If lobby is empty now, delete it
        if (race.players.length === 0) {
            if (race.lobbyTimer) clearInterval(race.lobbyTimer);
            if (race.countdownTimer) clearInterval(race.countdownTimer);
            delete races[raceId];
            console.log(`Race ${raceId} empty, deleting.`);
            return;
        }
        
        // Check state transitions
        if (race.status === 'waiting' || race.status === 'countdown') {
            // Update remaining players
            broadcastToRace(raceId, {
                type: 'lobby_update',
                players: getRacePlayers(raceId),
                settings: race.settings
            });
            
            // If countdown was active and we dropped below min players
            if (race.status === 'countdown' && race.players.length < race.settings.minPlayers) {
                cancelRaceCountdown(raceId);
            }
        } else if (race.status === 'racing') {
            // If in active race, check if all remaining players have finished
            const activePlayers = race.players.filter(pId => players[pId] && players[pId].state !== 'menu');
            const finishedCount = activePlayers.filter(pId => players[pId].state === 'finished').length;
            
            if (activePlayers.length === 0 || finishedCount >= activePlayers.length) {
                endRace(raceId);
            }
        }
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`CubeRacer Server listening on http://localhost:${PORT}`);
});
