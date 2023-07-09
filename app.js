const dgram     = require('dgram');
const socket    = dgram.createSocket('udp4');

let ServerManager = require("./serverManager.js");
var QueryInterval = null;

// LAN Beacon will only respond if it's coming from the actual local IP, not localhost
function getIPAddress() {
    var interfaces = require('os').networkInterfaces();
    for (var devName in interfaces) {
        var iface = interfaces[devName];

        for (var i = 0; i < iface.length; i++) {
        var alias = iface[i];
        if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal)
            return alias.address;
        }
    }
    return '0.0.0.0';
}

let svManager = new ServerManager("./config.json");

function Tick () { 

    // LAN BEACON QUERY PACKET
    let message = new Buffer("08014d5707db6b5fa5e553510d6fe2b0d4d90cb9","hex");

    // Send packet
    socket.send(message, 0, message.length, 14001, '255.255.255.255', (err, bytes) => {
        
        if (err) {

            console.error('broadcast error', err)
            return;
        }
    });
}

function cleanUp() {

    if (process.exitTimeoutId) return;
    svManager.Shutdown();
    process.exitTimeoutId = setTimeout(() => { process.exit() }, 2000);
}

socket.on('listening', function () {
    
	socket.setBroadcast(true);
    QueryInterval = setInterval( Tick, 1000);
    svManager.Start();
});

socket.on('message', function (message, remote) {

    let packet = new Buffer(message,"hex");
    
    svManager.parsePacket( packet );
});

process.on('SIGTERM', cleanUp );
process.on('SIGINT', cleanUp );

let broadcastAddr = process.platform === "win32" ? getIPAddress() : "0.0.0.0";
socket.bind('14001', broadcastAddr );
