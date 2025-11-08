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
import { options as cliOptions } from './cli-options.js'; // Command line option definitions
import { detectAdapters } from '../util/adapter-detect.js'; // Auto-detect Bluetooth and ANT+ adapters when the user does not specify them
import { initializeBluetooth } from '../util/noble-wrapper.js'; // Bluetooth initialization (runs after we set adapter env vars)
import { isSingleAdapterMultiRoleCapable } from '../util/hardware-info.js'; // Hardware helper to detect whether one adapter can safely scan + advertise.

/**
 * Convert a kebab-case CLI option name into the camelCase property that yargs
 * exposes on the parsed argv object. Example: `heart-rate-enabled` becomes
 * `heartRateEnabled`.
 */
const toCamelCase = (flagName) => flagName.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());

/**
 * Scan the raw argv tokens (before yargs parsing) and record which long-form
 * flags the user actually typed. We need this so that defaults coming from
 * yargs do not stomp on values loaded from gymnasticon.json. Think of this as
 * a tiny pre-parser that only cares about presence, not the actual values.
 */
function collectProvidedOptions(rawArgs, optionDefinitions) {
    const provided = new Set();
    const validFlags = new Set(Object.keys(optionDefinitions));

    for (let i = 0; i < rawArgs.length; i++) {
        const token = rawArgs[i];
        if (token === '--') {
            break; // everything after `--` is positional data; no more options
        }
        if (!token.startsWith('--')) {
            continue; // we intentionally ignore short aliases to keep logic simple
        }
        let flag = token.slice(2);
        const eqIndex = flag.indexOf('=');
        if (eqIndex >= 0) {
            flag = flag.slice(0, eqIndex); // remove `=value` suffix
        }
        if (flag.startsWith('no-')) {
            flag = flag.slice(3); // yargs models `--no-foo` as the `foo` option
        }
        if (validFlags.has(flag)) {
            provided.add(toCamelCase(flag));
        }
    }

    return provided;
}

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
const buildAppOptions = ({ _, $0, ...rest }) => rest;

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
    const rawArgs = hideBin(process.argv); // Capture the raw argv first so we can see what the user actually typed.
    const providedOptions = collectProvidedOptions(rawArgs, cliOptions); // Record the explicit flags for later precedence decisions.

    // Parse command line arguments using yargs
    // hideBin removes the first two arguments (node executable and script path)
    const argv = yargs(rawArgs)
        // Add all our custom command line options
        .options(cliOptions)
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

    const discovery = detectAdapters(); // Gather available adapters and ANT+ presence for sensible defaults.
    if (!argv.bikeAdapter) { // If the user did not specify a bike adapter, fall back to the detected value.
        argv.bikeAdapter = discovery.bikeAdapter;
    }
    if (!argv.serverAdapter) { // Likewise for the BLE advertising adapter.
        argv.serverAdapter = discovery.serverAdapter;
    }

    const antFlag = typeof argv.antPlus === 'boolean' ? argv.antPlus : undefined; // Interpret explicit ANT+ enable/disable requests.
    const antAuto = argv.antAuto === undefined ? true : argv.antAuto; // Default auto mode to true when not provided.
    argv.antEnabled = antFlag !== undefined ? antFlag : (antAuto && discovery.antPresent); // Enable ANT+ when the user forces it or auto-detect finds hardware.

    argv.speedFallback = { // Collect speed estimation overrides into a single object consumed by the App.
        circumferenceM: argv.speedCircumference,
        gearFactor: argv.speedGearFactor,
        min: argv.speedMin,
        max: argv.speedMax
    };
    delete argv.antPlus; // Drop intermediate flags so the App receives only the consolidated antEnabled switch.
    delete argv.speedCircumference; // Remove raw CLI fields now that they have been normalized.
    delete argv.speedGearFactor;
    delete argv.speedMin;
    delete argv.speedMax;

    const adapterPool = new Set(discovery.adapters ?? []); // Track every adapter we can see so far.
    if (argv.bikeAdapter) adapterPool.add(argv.bikeAdapter);
    if (argv.serverAdapter) adapterPool.add(argv.serverAdapter);
    const hasMultiAdapter = adapterPool.size >= 2; // True when at least two radios are available (dedicated scan/advertise roles).
    const singleAdapterCapability = isSingleAdapterMultiRoleCapable();
    const canSingleAdapterHandleHr = adapterPool.size === 1 && singleAdapterCapability.capable;
    const canAutoEnableHr = hasMultiAdapter || canSingleAdapterHandleHr;

    if (!argv.heartRateAdapter) {
        const detectedAdapters = discovery.adapters ?? [];
        const candidateAdapter = detectedAdapters.find(
            (adapter) => adapter !== argv.bikeAdapter && adapter !== argv.serverAdapter
        );
        if (candidateAdapter) {
            argv.heartRateAdapter = candidateAdapter; // Prefer an unused adapter when a second radio is present.
        }
    }

    if (argv.heartRateDevice && argv.heartRateEnabled === undefined) {
        // Only auto-enable the heart-rate bridge when the system truly has two adapters
        // OR the detected board is on the single-adapter whitelist (Pi Zero 2 W, Pi 3/4, etc.).
        if (canAutoEnableHr) {
            argv.heartRateEnabled = true;
        } else {
            console.warn('[Gymnasticon] Heart-rate device requested but only one adapter detected. Attach a second radio or set --heart-rate-enabled true after confirming stability. (Hint: export GYMNASTICON_SINGLE_ADAPTER_HR=1 to override on trusted hardware.)');
        }
    }

    const configPath = argv.configPath || argv.config || '/etc/gymnasticon.json'; // Support both legacy --config and explicit --config-path.

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

    // Delay importing the heavy Gymnasticon runtime until after the environment
    // variables above are set so noble/bleno honor the adapter overrides.
    const { GymnasticonApp } = await import('./gymnasticon-app.js');

    let heartRateNoble;
    if (argv.heartRateAdapter && argv.heartRateAdapter !== argv.bikeAdapter) {
        try {
            const hrBluetooth = await initializeBluetooth(argv.heartRateAdapter, {forceNewInstance: true});
            heartRateNoble = hrBluetooth.noble;
        } catch (err) {
            console.warn('[Gymnasticon] Unable to initialize heart-rate adapter', argv.heartRateAdapter, err);
        }
    }

    // Create and Start Application
    // ---------------------------
    const appOptions = {
        ...buildAppOptions(argv),
        noble,
        heartRateNoble,
        configPath,
        providedOptions: Array.from(providedOptions), // Pass the explicit CLI keys through so config merging can respect user intent.
    };
    const app = new GymnasticonApp(appOptions);

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
