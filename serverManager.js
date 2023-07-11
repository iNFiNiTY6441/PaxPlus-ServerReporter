const fetch     = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const fs        = require("fs");

class ServerManager {

    Servers = {};

    messageQueue = [];

    Interval_Heartbeat = null;
    Interval_Tick = null;

    Status_Ready = false;
    Status_NetIssues = false;

    Settings = null;


    constructor( configPath ) {

        let configFile = fs.readFileSync( configPath, "utf-8" );
        let configJSON = JSON.parse( configFile );
    
        this.Settings = configJSON;

        if ( !this.Settings ) throw new Error("Couldn't set ServerManager settings from config! ");
    }

    /**
     * Fetches the new client configuration from the masterserver and updates it accordingly
     */

    async updateConfigFromMasterserver() {


        let newConfig = await fetch( this.Settings.Local.MasterServerURL+"/config", {
            method: "GET",
            headers: {
                "Content-Type": "application/json"
            }
        })
        .then(response => response.json())
        .then(response => { return response });
        
        // MASTERSERVER CONFIG CHANGED
        if ( JSON.stringify( newConfig ) != JSON.stringify( this.Settings.Remote ) ) {
    
            // Reset heartbeat interval with new timing
            clearInterval( this.Interval_Heartbeat );
            this.Interval_Heartbeat = setInterval( this.heartBeat.bind(this), this.Settings.Remote.HeartbeatInterval );
    
            this.Settings.Remote = newConfig;
        }

    }

    printConsole(){

        console.clear()
        console.log("");
        console.log("_______ PAX+ SERVER REPORTING CLIENT ______\r\n");
        console.log("  [STATUS]: CONNECTED \r\n\r\n");
        console.log("___________ SERVICE ANNOUNCEMENT __________\r\n")
        console.log("  " + this.Settings.Remote.ServiceMessage );
        console.log("\r\n\r\n")
        console.log("__________ REGISTERED LAN SERVERS _________\r\n")
    
        for ( let x in this.Servers ) {
    
            console.log( this.Servers[x].name+" ["+this.Servers[x].players+" / "+this.Servers[x].maxPlayers+"]\r\n  Timeout: "+this.Servers[x].timeout );
            console.log("\r\n\r\n");
        }
    }

    /**
     * Queues a backend message for a server listing
     * 
     * @param { String } type Listing action type ( Add, Update, Delete )
     * @param { Object } serverData Server listing object to perform the action on
     */

    queueMessage( type, serverData ) {

        this.messageQueue.push({
            type: type,
            server: serverData
        });
    }

    /**
     * Sends all queued backend messages to the masterserver
     */
    
    sendMessages() {

        // Nothing to send?
        if ( this.messageQueue.length == 0 ) return;

        // Send messages
        console.log(this.Settings)
        let request = fetch( this.Settings.Local.MasterServerURL+"/serverListings", {
            method: "PUT",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify( this.messageQueue )
        }).catch(err => {

            console.log("PUT serverListings FAILED!\r\n"+err.message)
        });
        // Everything sent, clear backlog
        this.messageQueue = [];
    }

    /**
     * Adds a new server to the internal map and queues registration for the masterserver
     * 
     * @param { Object } serverData Server listing object
     */

    addServer( serverData ) {

        // Server exists already?
        if ( this.Servers[ serverData.port ] ) {

            // Equalize timeout for a quick comparison
            serverData.timeout = this.Servers[ serverData.port ].timeout;

            if ( JSON.stringify( this.Servers[ serverData.port ] ) != JSON.stringify( serverData ) ) {
                
                // Reset timeout & add listing
                serverData.timeout = 0;
                this.Servers[ serverData.port ] = serverData;

                // Queue up masterserver notify message
                this.queueMessage( "update", serverData );
            }

            // Reset timeout
            this.Servers[ serverData.port ].timeout = 0;
            
        } else {

            // Add new listing
            this.Servers[ serverData.port ] = {};
            this.Servers[ serverData.port ] = serverData;

            // Queue up masterserver notify message
            this.queueMessage( "add", serverData );
        }

    }

    /**
     * Removes servers that have not replied for a while
     */

    expireServers() {

        // Increase expire number for all servers
        for ( let port in this.Servers ) {

            // Increase expiry timer
            this.Servers[ port ].timeout++;

            // Scrub listings that are outdated
            if ( this.Servers[ port ].timeout > this.Settings.Local.ExpireTicks ) {

                // Queue up masterserver notify message & delete listing
                this.queueMessage( "delete", this.Servers[ port ] );
                delete this.Servers[ port ];
            }

        }

    }

    /**
     * Delists all servers from the masterserver and removes them from the local listings.
     */

    clearServers() {
        //console.clear();
        console.log("Delisting servers...");
        this.messageQueue = [];
        for ( let port in this.Servers ) this.queueMessage( "delete", this.Servers[ port ] );
        this.Servers = {};
        this.sendMessages();
    }

    parsePacket( udpPacket ) {

        let messageType = udpPacket.toString( 'utf8', 10, 12 );                                // BYTE 12: Message type (SQ: Query, SR: Response)

        // Ditch early if not a server response
        if ( messageType != "SR" ) return;

        let ipDigits = [];
        ipDigits.push( parseInt( udpPacket.toString( 'hex', 20, 21 ) , 16 ) );                 // BYTE 21: 1st IPv4 address digit
        ipDigits.push( parseInt( udpPacket.toString( 'hex', 21, 22 ) , 16 ) );                 // BYTE 22: 2nd IPv4 address digit
        ipDigits.push( parseInt( udpPacket.toString( 'hex', 22, 23 ) , 16 ) );                 // BYTE 23: 3rd IPv4 address digit
        ipDigits.push( parseInt( udpPacket.toString( 'hex', 23, 24 ) , 16 ) );                 // BYTE 24: 4th IPv4 address digit

        // UNUSED: All PAX servers are LAN servers, so they only report the local IP
        let svInfo_ip = ipDigits.join(".");

        let svInfo_port = parseInt( udpPacket.toString( 'hex', 26, 28 ) , 16 )                 // BYTES 27 & 28: Server port encoded as 2-Byte int
        let svInfo_openSlots = parseInt( udpPacket.toString( 'hex', 31, 32 ) , 16 );           // BYTE 32: Remaining open slots on server
        let svInfo_maxSlots = parseInt( udpPacket.toString( 'hex', 39, 40 ) , 16 );            // BYTE 40: Total server slots
        
        let svInfo_name = udpPacket.toString('utf8', 64, udpPacket.length).replace(/\0/g, '');    // BYTE 65-END: Server name appended to end of udpPacket

        let currentPlayerCount = svInfo_maxSlots - svInfo_openSlots;

        // Build the listing object
        let serverListing = {

            name: svInfo_name,
            players: currentPlayerCount,
            maxPlayers: svInfo_maxSlots,
            port: svInfo_port,
            timeout: 0
        }

        this.addServer( serverListing );
    }

    /**
     * Re-broadcasts all servers to the masterserver to prevent delisting and updates 
     * the masterserver-issued configuration if needed
     */

    heartBeat() {

        this.updateConfigFromMasterserver();

        for ( let server in this.Servers ) this.queueMessage( "add", this.Servers[ server ] );
    }

    /**
     * Handles sending the backlog of stored messages for the masterserver, and expiring outdated server listings
     */

    tick () {

        this.expireServers();
        this.sendMessages();
        this.printConsole();
    }

    /**
     * Starts internal update & tick logic
     */

    Start() {

        this.Interval_Tick = setInterval( this.tick.bind(this), this.Settings.Local.TickInterval );
        this.Interval_Heartbeat = setInterval( this.heartBeat.bind(this), this.Settings.Remote.HeartbeatInterval );
    }

    /**
     *  Stops internal update & tick logic
     */

    Stop() {

        clearInterval( this.Interval_Heartbeat );
        clearInterval( this.Interval_Tick );
    }

    /**
     * Executes all the necessary steps for a clean shutdown. 
     * Properly delists all servers from the masterserver and cancels all internal intervals.
     */

    Shutdown() {

        this.Stop();
        this.clearServers();
    }

}
module.exports = ServerManager;