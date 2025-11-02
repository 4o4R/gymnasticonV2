#!/usr/bin/env node

/**
 * Command Line Interface (CLI) Entry Point for Gymnasticon
 * ====================================================
 * 
 * This file is the starting point of the application when run from the command line.
 * It handles:
 * 1. Parsing command line arguments
 * 2. Loading configuration files
 * 3. Setting up environment variables
 * 4. Initializing the main application
 * 
 * The shebang line above (#!) tells Unix-like systems to run this with Node.js
 */

// Built-in Node.js Modules
// -----------------------
import { readFileSync } from 'fs';        // For reading configuration files
import { resolve } from 'path';           // For handling file paths

// Third-party Dependencies
// ----------------------
// yargs: A command-line argument parser that makes it easy to build interactive commands
// Import yargs using the package's public entrypoint. Avoid importing internal
// subpaths (like 'yargs/yargs.js') because packages may restrict those via
// the "exports" field in package.json which causes ERR_PACKAGE_PATH_NOT_EXPORTED.
import yargs from 'yargs';
// Import the helper from the public helpers subpath. Do not include a .js
// extension here so Node can resolve the package export correctly.
import { hideBin } from 'yargs/helpers';  // Removes Node.js binary path from argv

// Local Application Imports
// ------------------------
import { App } from './app.js';                          // Main application class
import { options as cliOptions } from './cli-options.js'; // Command line option definitions
import { initializeBluetooth } from '../util/noble-wrapper.js'; // Bluetooth initialization

/**
 * Configuration File Loader
 * ------------------------
 * Loads and parses a JSON configuration file from the specified path.
 * 
 * @param {string} configPath - Path to the configuration file
 * @returns {Object} The parsed configuration object
 * 
 * Example config file:
 * {
 *   "bikeType": "flywheel",
 *   "serverName": "My Gymnasticon"
 * }
 */
const loadConfig = (configPath) => {
    // Convert relative paths to absolute paths
    const fullPath = resolve(configPath);
    
    // Read the file synchronously (blocking)
    // We use utf8 encoding for text files
    const contents = readFileSync(fullPath, 'utf8');
    
    // Parse the JSON content into a JavaScript object
    return JSON.parse(contents);
};

/**
 * Builds the application options object by filtering out yargs-specific properties
 * 
 * @param {Object} args - The parsed command line arguments
 * @param {string} args._ - Contains all non-option arguments (removed)
 * @param {string} args.$0 - The script name (removed)
 * @param {Object} args.config - The config file contents (removed)
 * @param {Object} rest - All other arguments that will be passed to the app
 * @returns {Object} Clean options object for the application
 */
const buildAppOptions = ({ _, $0, config, ...rest }) => rest;

/**
 * Main Application Entry Point
 * ---------------------------
 * This async function initializes and runs the entire application.
 * It handles:
 * 1. Command line argument parsing
 * 2. Environment setup
 * 3. Bluetooth initialization
 * 4. Application startup
 * 5. Graceful shutdown
 */
const main = async () => {
    // Parse command line arguments using yargs
    // hideBin removes the first two arguments (node executable and script path)
    const argv = yargs(hideBin(process.argv))
        // Add all our custom command line options
        .options(cliOptions)
        // Enable loading options from a config file
        .config('config', loadConfig)
        // Allow --my-option to be passed as --myOption
        .parserConfiguration({ 'camel-case-expansion': true })
        // Add --help option
        .help()
        // Add -h as alias for --help
        .alias('h', 'help')
        // Fail on unknown arguments
        .strict()
        // Parse the arguments
        .parse();

    // Configure Bluetooth Adapters and Settings
    // ----------------------------------------
    // If a specific Bluetooth adapter is specified for the bike connection
    if (argv.bikeAdapter) {
        // Set the Noble (BLE client) adapter ID
        // Noble is used to connect to the exercise bike
        process.env.NOBLE_HCI_DEVICE_ID = argv.bikeAdapter;
        
        // Enable multiple concurrent BLE roles (central and peripheral)
        // This allows us to connect to the bike while also advertising to apps
        process.env.NOBLE_MULTI_ROLE = '1';
        
        // Enable extended BLE scanning for better device discovery
        process.env.NOBLE_EXTENDED_SCAN = '1';
    }

    // If a specific Bluetooth adapter is specified for the server (connects to apps)
    if (argv.serverAdapter) {
        // Set the Bleno (BLE peripheral) adapter ID
        // Bleno is used to advertise to and connect with fitness apps
        process.env.BLENO_HCI_DEVICE_ID = argv.serverAdapter;
        
        // Set maximum number of simultaneous connections if not already set
        // This allows multiple apps to connect at once (e.g., Zwift + heart rate app)
        if (!process.env.BLENO_MAX_CONNECTIONS) {
            process.env.BLENO_MAX_CONNECTIONS = '3';
        }
    }

    // Initialize Bluetooth Stack
    // -------------------------
    // This sets up the BLE (Bluetooth Low Energy) subsystem
    const { noble } = await initializeBluetooth(argv.bikeAdapter);

    // Create and Start Application
    // ---------------------------
    // Create a new instance of our main application class
    const app = new App({
        // Spread the cleaned command line options
        ...buildAppOptions(argv),
        // Pass the initialized Bluetooth stack
        noble
    });

    // Start the application (connects to bike, starts BLE server)
    await app.start();

    // Keep Process Alive
    // -----------------
    // Prevent Node.js from exiting by resuming stdin
    // This is needed because we're running a server process
    process.stdin.resume();

    /**
     * Graceful Shutdown Handler
     * ------------------------
     * This function ensures we clean up resources before exiting:
     * - Disconnects from the bike
     * - Stops the BLE server
     * - Closes Bluetooth connections
     */
    const shutdown = async () => {
        try {
            // Attempt to stop the application gracefully
            await app.stop();
        } finally {
            // Always exit the process, even if cleanup fails
            process.exit(0);
        }
    };

    // Register Shutdown Handlers
    // ------------------------
    // Listen for termination signals:
    // SIGINT  - Sent when user presses Ctrl+C
    // SIGTERM - Sent when system requests graceful termination
    ['SIGINT', 'SIGTERM'].forEach((signal) => {
        process.on(signal, shutdown);
    });
};

// Run the Application
// -----------------
// Call our main function and handle any unhandled errors
main().catch((err) => {
    // Log the error to stderr
    console.error(err);
    // Exit with error code 1 to indicate failure
    process.exit(1);
});
