const fs        = require("fs");
const dgram     = require('dgram');
const socket    = dgram.createSocket('udp4');
const fetch     = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const g_Config  = JSON.parse( fs.readFileSync( "./config.json","utf8" ) );

// Settings 
var g_Settings = {

    masterserverURL: process.env.masterserverURL || g_Config.masterserverURL,
    expireTicks: process.env.expireTicks || g_Config.expireTicks || 4
}

// Internal server listing map
let g_Servers = {};

// Queued LAN beacon responses that need to be processed per tick
let g_BeaconResponses = [];

// Queued masterserver listing updates that need to be sent per tick
let g_MasterserverMessages = [];

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

/**
 * Adds / updates a server listing in the internal listing table
 * @param { Object } serverListing The server listing to add / update
 */

function addServerlisting( serverListing ) {

    // Server exists already?
    if ( g_Servers[ serverListing.port ] ) {

        // Equalize timeout for a quick comparison
        serverListing.timeout = g_Servers[ serverListing.port ].timeout;

        if ( JSON.stringify( g_Servers[ serverListing.port ] ) != JSON.stringify( serverListing ) ) {
            
            // Reset timeout & add listing
            serverListing.timeout = 0;
            g_Servers[ serverListing.port ] = serverListing;

            // Queue up masterserver notify message
            queueMasterserverMessage( "update", serverListing );
        }

        // Reset timeout
        g_Servers[ serverListing.port ].timeout = 0;
        
    } else {

        // Add new listing
        g_Servers[ serverListing.port ] = {};
        g_Servers[ serverListing.port ] = serverListing;

        // Queue up masterserver notify message
        queueMasterserverMessage( "add", serverListing );
    }

}

/**
 * Deletes internal server listings that have not been updated for X amount of ticks
 * @param { Int } expireTick Expire listings after this many ticks
 */

function expireListings( expireTick ){

    // Increase expire number for all servers
    for ( let port in g_Servers ) {

        // Increase expiry timer
        g_Servers[ port ].timeout++;

        // Scrub listings that are outdated
        if ( g_Servers[ port ].timeout > expireTick ) {

            // Queue up masterserver notify message & delete listing
            queueMasterserverMessage( "delete", g_Servers[ port ] );
            delete g_Servers[ port ];
        }

    }

}

/**
 * Reads server info from a LAN beacon response packet and adds new servers to the internal serverlist
 * @param {Buffer} packet UDP packet encoded has a hex buffer
 */

function processServerResponsePacket( packet ) {

    let messageType = packet.toString( 'utf8', 10, 12 );                                // BYTE 12: Message type (SQ: Query, SR: Response)

    // Ditch early if not a server response
    if ( messageType != "SR" ) return;

    let ipDigits = [];
    ipDigits.push( parseInt( packet.toString( 'hex', 20, 21 ) , 16 ) );                 // BYTE 21: 1st IPv4 address digit
    ipDigits.push( parseInt( packet.toString( 'hex', 21, 22 ) , 16 ) );                 // BYTE 22: 2nd IPv4 address digit
    ipDigits.push( parseInt( packet.toString( 'hex', 22, 23 ) , 16 ) );                 // BYTE 23: 3rd IPv4 address digit
    ipDigits.push( parseInt( packet.toString( 'hex', 23, 24 ) , 16 ) );                 // BYTE 24: 4th IPv4 address digit

    // UNUSED: All PAX servers are LAN servers, so they only report the local IP
    let svInfo_ip = ipDigits.join(".");

    let svInfo_port = parseInt( packet.toString( 'hex', 26, 28 ) , 16 )                 // BYTES 27 & 28: Server port encoded as 2-Byte int
    let svInfo_openSlots = parseInt( packet.toString( 'hex', 31, 32 ) , 16 );           // BYTE 32: Remaining open slots on server
    let svInfo_maxSlots = parseInt( packet.toString( 'hex', 39, 40 ) , 16 );            // BYTE 40: Total server slots
    
    let svInfo_name = packet.toString('utf8', 64, packet.length).replace(/\0/g, '');    // BYTE 65-END: Server name appended to end of packet

    let currentPlayerCount = svInfo_maxSlots - svInfo_openSlots;

    // Build the listing object
    let serverListing = {

        name: svInfo_name,
        players: currentPlayerCount,
        maxPlayers: svInfo_maxSlots,
        port: svInfo_port,
        timeout: 0
    }

    // Update the internal serverlist with the listing from this packet
    addServerlisting( serverListing );
}


/**
 * Queues a masterserver message. All queued messages will be sent on the next update tick.
 * 
 * @param {*} messageType Action to perform on the masterserver ( add / update / delete )
 * @param {*} serverData The server listing to perform the action with
 */

function queueMasterserverMessage( messageType, serverData ) {

    g_MasterserverMessages.push({
        type: messageType,
        server: serverData
    });
}

/**
 * POSTs all queued master server notify messages to the masterserver endpoint.
 */

function sendMasterserverMessages() {

    // Nothing to send?
    if ( g_MasterserverMessages.length == 0 ) return;

    // Send messages
    let post = fetch("http://127.0.0.1:3000/serverListings", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify( g_MasterserverMessages )
    }).catch(err => {

        // Connection trouble: 
        // Clear internal serverlistings so all of them are resent to the server on next attempt

        g_Servers = {};
        console.log("POST serverListings FAILED!\r\n"+err.message)
    });
    // Everything sent, clear backlog
    g_MasterserverMessages = [];
}


/**
 * Prints the internal serverlist to console
 */

function printServerListings(){

    console.clear()
    console.log("========= REGISTERED LAN SERVERS ==========\r\n")

    for ( let x in g_Servers ) {

        console.log( g_Servers[x].name+" ["+g_Servers[x].players+" / "+g_Servers[x].maxPlayers+"]\r\n  Timeout: "+g_Servers[x].timeout );
        console.log("\r\n\r\n");
    }

}

function updateTick(){ 

    // LAN BEACON QUERY PACKET
    let message = new Buffer("08014d5707db6b5fa5e553510d6fe2b0d4d90cb9","hex");

    // Send packet
    socket.send(message, 0, message.length, 14001, '255.255.255.255', (err, bytes) => {
        
        if (err) {

            console.error('broadcast error', err)
            return;
        }

        // Process through the reply backlog & update according listings
        for( let r in g_BeaconResponses ) {
            processServerResponsePacket( g_BeaconResponses[r] );
        }
        g_BeaconResponses = [];

        expireListings( g_Settings.expireTicks );

        sendMasterserverMessages();
        printServerListings()
    });
}

let LOCAL_IP_ADDRESS =  getIPAddress();

socket.on('listening', function () {
    
	socket.setBroadcast(true);

    setInterval( updateTick, 1000);

});

/**
 *  Push all received beacon responses into a backlog.
 *  All backlog responses will be processed on the next update tick
 */
socket.on('message', function (message, remote) {

    let packet = new Buffer(message,"hex");
    g_BeaconResponses.push( packet );
});

socket.bind('14001',LOCAL_IP_ADDRESS);
