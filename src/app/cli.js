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
import fs from 'fs/promises'; // Read config early so adapter env vars match persisted settings.
import { options as cliOptions } from './cli-options.js'; // Command line option definitions
import { detectAdapters, supportsExtendedScan } from '../util/adapter-detect.js'; // Auto-detect Bluetooth and ANT+ adapters when the user does not specify them
import { initializeBluetooth } from '../util/noble-wrapper.js'; // Bluetooth initialization (runs after we set adapter env vars)
import { normalizeAdapterId, normalizeAdapterName } from '../util/adapter-id.js'; // Normalize hci0 -> 0 for noble/bleno env vars
import { isSingleAdapterMultiRoleCapable } from '../util/hardware-info.js'; // Decide when bike adapter can safely advertise too

/**
 * Convert a kebab-case CLI option name into the camelCase property that yargs
 * exposes on the parsed argv object. Example: `heart-rate-enabled` becomes
 * `heartRateEnabled`.
 */
const toCamelCase = (flagName) => flagName.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());

/**
 * Normalize config keys so "bike-adapter" becomes "bikeAdapter", matching yargs.
 */
const normalizeConfigKeys = (config = {}) => {
    const normalized = {};
    for (const [key, value] of Object.entries(config)) {
        normalized[toCamelCase(key)] = value;
    }
    return normalized;
};

const normalizeAdapterList = (value) => {
    if (!value) {
        return [];
    }
    if (Array.isArray(value)) {
        return value
            .map(item => normalizeAdapterName(item))
            .map(item => (item ? String(item).trim() : ''))
            .filter(Boolean);
    }
    if (typeof value === 'string') {
        return value
            .split(',')
            .map(item => normalizeAdapterName(item))
            .map(item => (item ? String(item).trim() : ''))
            .filter(Boolean);
    }
    return [];
};

const dedupeAdapters = (list) => {
    const seen = new Set();
    const result = [];
    list.forEach((adapter) => {
        if (!adapter || seen.has(adapter)) {
            return;
        }
        seen.add(adapter);
        result.push(adapter);
    });
    return result;
};

const buildServerAdapters = ({ explicit, serverAdapter, bikeAdapter, detectedAdapters, bleMultiOutput, allowBikeMirror }) => {
    const normalizedServer = normalizeAdapterName(serverAdapter);
    const normalizedBike = normalizeAdapterName(bikeAdapter);
    const normalizedDetected = detectedAdapters.map(adapter => normalizeAdapterName(adapter)).filter(Boolean);
    const hasDetected = normalizedDetected.length > 0;
    const filterDetected = (list) => hasDetected
        ? list.filter(adapter => normalizedDetected.includes(adapter))
        : list;

    const filteredExplicit = filterDetected(explicit);
    if (explicit.length && filteredExplicit.length !== explicit.length) {
        console.warn('[gym-cli] Dropping missing server adapters:', explicit.filter(adapter => !filteredExplicit.includes(adapter)));
    }
    if (filteredExplicit.length) {
        return dedupeAdapters(filteredExplicit);
    }

    const adapters = [];
    if (normalizedServer) {
        adapters.push(normalizedServer);
    }

    if (bleMultiOutput === false) {
        return dedupeAdapters(adapters);
    }

    if (hasDetected) {
        normalizedDetected.forEach((adapter) => {
            if (adapter && adapter !== normalizedBike) {
                adapters.push(adapter);
            }
        });
    }

    if (allowBikeMirror && normalizedBike) {
        adapters.push(normalizedBike);
    }

    return dedupeAdapters(adapters);
};

/**
 * Best-effort config loader used before BLE init so adapter env vars are correct.
 */
const loadConfigFile = async (configPath) => {
    try {
        const raw = await fs.readFile(configPath, 'utf8');
        return normalizeConfigKeys(JSON.parse(raw));
    } catch (error) {
        // Teaching note: missing config is fine; we just fall back to CLI defaults.
        if (error?.code === 'ENOENT') {
            return {};
        }
        throw error;
    }
};

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
    console.log('[gym-cli] Gymnasticon CLI starting...');
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

    const configPath = argv.configPath || argv.config || '/etc/gymnasticon.json'; // Support both legacy --config and explicit --config-path.
    console.log('[gym-cli] Using config path:', configPath);
    const configOverrides = await loadConfigFile(configPath); // Teaching note: read config now so BLE env vars match the file.

    // Teaching note: only apply config defaults when the user did NOT explicitly pass the flag.
    if (!providedOptions.has('bikeAdapter') && configOverrides.bikeAdapter) {
        argv.bikeAdapter = configOverrides.bikeAdapter;
    }
    if (!providedOptions.has('serverAdapter') && configOverrides.serverAdapter) {
        argv.serverAdapter = configOverrides.serverAdapter;
    }
    if (!providedOptions.has('serverAdapters') && configOverrides.serverAdapters) {
        argv.serverAdapters = configOverrides.serverAdapters;
    }
    if (!providedOptions.has('heartRateAdapter') && configOverrides.heartRateAdapter) {
        argv.heartRateAdapter = configOverrides.heartRateAdapter;
    }
    if (!providedOptions.has('heartRateEnabled') && configOverrides.heartRateEnabled !== undefined) {
        argv.heartRateEnabled = configOverrides.heartRateEnabled;
    }
    if (!providedOptions.has('bleMultiOutput') && configOverrides.bleMultiOutput !== undefined) {
        argv.bleMultiOutput = configOverrides.bleMultiOutput;
    }

    const discovery = detectAdapters(); // Gather available adapters and ANT+ presence for sensible defaults.
    if (!argv.bikeAdapter) { // If the user did not specify a bike adapter, fall back to the detected value.
        argv.bikeAdapter = discovery.bikeAdapter;
    }
    if (!argv.serverAdapter) { // Likewise for the BLE advertising adapter.
        argv.serverAdapter = discovery.serverAdapter;
    }
    if (argv.bikeAdapter) {
        argv.bikeAdapter = normalizeAdapterName(argv.bikeAdapter) || argv.bikeAdapter;
    }
    if (argv.serverAdapter) {
        argv.serverAdapter = normalizeAdapterName(argv.serverAdapter) || argv.serverAdapter;
    }
    if (argv.heartRateAdapter) {
        argv.heartRateAdapter = normalizeAdapterName(argv.heartRateAdapter) || argv.heartRateAdapter;
    }
    const multiRoleInfo = isSingleAdapterMultiRoleCapable();
    const explicitServerAdapters = normalizeAdapterList(argv.serverAdapters);
    const serverAdapters = buildServerAdapters({
        explicit: explicitServerAdapters,
        serverAdapter: argv.serverAdapter,
        bikeAdapter: argv.bikeAdapter,
        detectedAdapters: discovery.adapters || [],
        bleMultiOutput: argv.bleMultiOutput,
        allowBikeMirror: multiRoleInfo.capable,
    });
    if (serverAdapters.length) {
        argv.serverAdapters = serverAdapters;
        argv.serverAdapter = serverAdapters[0];
    }

    const antFlag = typeof argv.antPlus === 'boolean' ? argv.antPlus : undefined; // Track whether the caller explicitly passed --ant-plus / --no-ant-plus.
    const antAuto = argv.antAuto === undefined ? true : argv.antAuto; // Treat auto mode as enabled unless the config/CLI disabled it.
    argv.antAuto = antAuto; // Persist the normalized boolean so the runtime can inspect the actual setting later.
    if (antFlag !== undefined) { // Respect explicit user intent first.
        argv.antEnabled = antFlag; // Use the exact value supplied on the CLI/config.
    } else if (antAuto) { // Auto mode active (default): always attempt to broadcast and let hardware detection happen inside the ANT stack.
        argv.antEnabled = true; // Turn on ANT+ broadcasting proactively; startAnt() will quietly skip if no stick is present.
    } else {
        argv.antEnabled = false; // Auto mode disabled and no explicit override, so keep ANT+ off.
    }

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

    const adapterPool = new Set(discovery.adapters ?? []); // All HCIs we detected via sysfs.
    if (argv.bikeAdapter) adapterPool.add(argv.bikeAdapter); // Include overrides supplied by config/CLI to keep the count honest.
    if (argv.serverAdapter) adapterPool.add(argv.serverAdapter);
    if (Array.isArray(argv.serverAdapters)) {
        argv.serverAdapters.forEach(adapter => adapterPool.add(adapter));
    }
    const hasMultiAdapter = discovery.multiAdapter || adapterPool.size >= 2; // Treat either detected dual-HCI or explicit dual overrides as “multi”.
    argv.multiAdapter = hasMultiAdapter; // Pass through to the App so runtime decisions stay consistent with the CLI.
    if (argv.heartRateEnabled === undefined) { // Teaching note: only auto-pick when the user/config didn't decide.
        // On single-radio setups we disable by default to avoid flapping scans/ads.
        argv.heartRateEnabled = hasMultiAdapter;
    } else if (!hasMultiAdapter && argv.heartRateEnabled) {
        console.warn('[gym-cli] Heart-rate bridge forced on with a single adapter; expect BLE contention.');
    }

    // Configure Bluetooth Adapters and Settings
    // ----------------------------------------
    // If a specific Bluetooth adapter is specified for the bike connection
    if (argv.bikeAdapter) {
        // Teaching note: noble expects a numeric HCI index (0, 1, ...), so we
        // normalize "hci0" style names before exporting the environment var.
        const nobleAdapterId = normalizeAdapterId(argv.bikeAdapter);
        if (nobleAdapterId === undefined) {
            console.warn('[gym-cli] Unable to normalize bike adapter ID:', argv.bikeAdapter);
        } else {
            // Set the Noble (BLE client) adapter ID
            // Noble is used to connect to the exercise bike
            process.env.NOBLE_HCI_DEVICE_ID = nobleAdapterId;
        }
        
    }

    // If a specific Bluetooth adapter is specified for the server (connects to apps)
    if (argv.serverAdapter) {
        // Teaching note: bleno also expects a numeric HCI index in the env var,
        // so normalize "hci1" -> "1" to avoid "unknown" adapter state.
        const blenoAdapterId = normalizeAdapterId(argv.serverAdapter);
        if (blenoAdapterId === undefined) {
            console.warn('[gym-cli] Unable to normalize server adapter ID:', argv.serverAdapter);
        } else {
            // Set the Bleno (BLE peripheral) adapter ID
            // Bleno is used to advertise to and connect with fitness apps
            process.env.BLENO_HCI_DEVICE_ID = blenoAdapterId;
        }
        
        // Set maximum number of simultaneous connections if not already set
        // This allows multiple apps to connect at once (e.g., Zwift + heart rate app)
        if (!process.env.BLENO_MAX_CONNECTIONS) {
            process.env.BLENO_MAX_CONNECTIONS = '3';
        }
    }

    // Teaching note: multi-role is only needed when one adapter handles both
    // scanning (bike) and advertising (server). With two adapters, leaving it
    // off avoids unnecessary HCI quirks on older stacks.
    const serverAdapterList = Array.isArray(argv.serverAdapters)
        ? argv.serverAdapters
        : [argv.serverAdapter].filter(Boolean);
    const usesSingleAdapter = Boolean(
        argv.bikeAdapter &&
        serverAdapterList.includes(argv.bikeAdapter)
    );
    if (usesSingleAdapter) {
        process.env.NOBLE_MULTI_ROLE = '1';
    } else {
        delete process.env.NOBLE_MULTI_ROLE;
    }

    // Teaching note: extended scanning requires Bluetooth 5.0+ controllers.
    // On 4.1/4.2 radios (common on Pi Zero 2 W), forcing it can suppress
    // discover events entirely, so we disable it when unsupported.
    const extendedScan = supportsExtendedScan(argv.bikeAdapter);
    if (extendedScan.supported) {
        process.env.NOBLE_EXTENDED_SCAN = '1';
    } else {
        delete process.env.NOBLE_EXTENDED_SCAN;
    }
    if (argv.bikeAdapter) {
        const versionLabel = extendedScan.version ? ` (HCI ${extendedScan.version})` : '';
        console.log(`[gym-cli] extended scan ${extendedScan.supported ? 'enabled' : 'disabled'} for ${argv.bikeAdapter}${versionLabel}`);
    }

    // Initialize Bluetooth Stack
    // -------------------------
    // This sets up the BLE (Bluetooth Low Energy) subsystem
    const { noble } = await initializeBluetooth(argv.bikeAdapter);
    console.log('[gym-cli] Bluetooth initialized; noble state:', noble?.state);

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
