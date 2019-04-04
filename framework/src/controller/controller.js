const fs = require('fs-extra');
const path = require('path');
const child_process = require('child_process');
const psList = require('ps-list');
const systemDirs = require('./config/dirs');
const { InMemoryChannel } = require('./channels');
const Bus = require('./bus');
const { DuplicateAppInstanceError } = require('../errors');
const { validateModuleSpec } = require('./helpers/validator');

const isPidRunning = async pid =>
	psList().then(list => list.some(x => x.pid === pid));

/**
 * Controller logic responsible to run the application instance
 *
 * @class
 * @memberof framework.controller
 * @requires assert
 * @requires bluebird
 * @requires fs-extra
 * @requires helpers/config
 * @requires channels/event_emitter
 * @requires module.Bus
 */
class Controller {
	/**
	 * Controller responsible to run the application
	 *
	 * @param {string} appLabel - Application label
	 * @param {Object} config - Controller configurations
	 * @param {component.Logger} logger - Logger component responsible for writing all logs to output
	 */
	constructor(appLabel, config, logger) {
		this.logger = logger;
		this.appLabel = appLabel;
		this.logger.info('Initializing controller');

		const dirs = systemDirs(this.appLabel);
		this.config = {
			...config,
			dirs,
			socketsPath: {
				root: `unix://${dirs.sockets}`,
				pub: `unix://${dirs.sockets}/lisk_pub.sock`,
				sub: `unix://${dirs.sockets}/lisk_sub.sock`,
				rpc: `unix://${dirs.sockets}/lisk_rpc.sock`,
			},
		};

		this.modules = {};
		this.childrenList = [];
		this.channel = null; // Channel for controller
		this.bus = null;
	}

	/**
	 * Load the initial state and start listening for events or triggering actions.
	 * Publishes 'lisk:ready' state on the bus.
	 *
	 * @param modules
	 * @async
	 */
	async load(modules) {
		this.logger.info('Loading controller');
		await this._setupDirectories();
		await this._validatePidFile();
		await this._setupBus();
		await this._loadModules(modules);

		this.logger.info('Bus listening to events', this.bus.getEvents());
		this.logger.info('Bus ready for actions', this.bus.getActions());

		this.channel.publish('lisk:ready');
	}

	/**
	 * Verify existence of required directories.
	 *
	 * @async
	 */
	// eslint-disable-next-line class-methods-use-this
	async _setupDirectories() {
		// Make sure all directories exists
		await fs.ensureDir(this.config.dirs.temp);
		await fs.ensureDir(this.config.dirs.sockets);
		await fs.ensureDir(this.config.dirs.pids);
	}

	async _validatePidFile() {
		const pidPath = `${this.config.dirs.pids}/controller.pid`;
		const pidExists = await fs.pathExists(pidPath);
		if (pidExists) {
			const pidRunning = await isPidRunning(
				parseInt(await fs.readFile(pidPath))
			);
			if (pidRunning) {
				this.logger.error(
					`An instance of application "${
						this.appLabel
					}" is already running. You have to change application name to run another instance.`
				);
				throw new DuplicateAppInstanceError(this.appLabel, pidPath);
			}
		}
		await fs.writeFile(pidPath, process.pid);
	}

	/**
	 * Initialize bus
	 *
	 * @async
	 */
	async _setupBus() {
		this.bus = new Bus(
			{
				wildcard: true,
				delimiter: ':',
				maxListeners: 1000,
			},
			this.logger,
			this.config
		);

		await this.bus.setup();

		this.channel = new InMemoryChannel(
			'lisk',
			['ready'],
			{
				getComponentConfig: action => this.config.components[action.params],
			},
			{ skipInternalEvents: true }
		);

		await this.channel.registerToBus(this.bus);

		// If log level is greater than info
		if (this.logger.level && this.logger.level() < 30) {
			this.bus.onAny((name, event) => {
				this.logger.debug(
					`MONITOR: ${event.source} -> ${event.module}:${event.name}`,
					event.data
				);
			});
		}
	}

	async _loadModules(modules) {
		// To perform operations in sequence and not using bluebird
		// eslint-disable-next-line no-restricted-syntax
		for (const alias of Object.keys(modules)) {
			const { klass, options } = modules[alias];

			if (options.loadAsChildProcess) {
				if (this.config.ipc.enabled) {
					// eslint-disable-next-line no-await-in-loop
					await this._loadChildProcessModule(alias, klass, options);
				} else {
					this.logger.warn(
						`IPC is disabled. ${alias} will be loaded in-memory.`
					);
					// eslint-disable-next-line no-await-in-loop
					await this._loadInMemoryModule(alias, klass, options);
				}
			} else {
				// eslint-disable-next-line no-await-in-loop
				await this._loadInMemoryModule(alias, klass, options);
			}
		}
	}

	async _loadInMemoryModule(alias, Klass, options) {
		const module = new Klass(options);
		validateModuleSpec(module);

		const moduleAlias = alias || module.constructor.alias;
		const { name, version } = module.constructor.info;

		this.logger.info(
			`Loading module ${name}:${version} with alias "${moduleAlias}"`
		);

		const channel = new InMemoryChannel(
			moduleAlias,
			module.events,
			module.actions
		);

		await channel.registerToBus(this.bus);

		channel.publish(`${moduleAlias}:registeredToBus`);
		channel.publish(`${moduleAlias}:loading:started`);

		await module.load(channel);

		channel.publish(`${moduleAlias}:loading:finished`);

		this.modules[moduleAlias] = module;

		this.logger.info(
			`Module ready with alias: ${moduleAlias}(${name}:${version})`
		);
	}

	async _loadChildProcessModule(alias, Klass, options) {
		const module = new Klass(options);
		validateModuleSpec(module);

		const moduleAlias = alias || module.constructor.alias;
		const { name, version } = module.constructor.info;

		this.logger.info(
			`Loading module ${name}:${version} with alias "${moduleAlias}" as child process`
		);

		const modulePath = path.resolve(
			__dirname,
			'../modules',
			alias.replace(/([A-Z])/g, $1 => `_${$1.toLowerCase()}`)
		);

		const program = path.resolve(__dirname, 'child_process_loader.js');

		const parameters = [modulePath];

		const child = child_process.fork(program, parameters);

		// TODO: Check which config and options are actually required to avoid sending large data
		child.send({
			loadModule: true,
			config: this.config,
			moduleOptions: options,
		});

		this.childrenList.push(child);

		child.on('exit', (code, signal) => {
			this.logger.error(
				`Module ${moduleAlias}(${name}:${version}) exited with code: ${code} and signal: ${signal}`
			);

			// Exits the main process with a failure code
			process.exit(1);
		});

		return Promise.race([
			new Promise(resolve => {
				this.channel.once(`${moduleAlias}:loading:finished`, () => {
					this.logger.info(
						`Module ready with alias: ${moduleAlias}(${name}:${version})`
					);
					resolve();
				});
			}),
			new Promise((_, reject) => {
				setTimeout(reject, 2000);
			}),
		]);
	}

	async unloadModules(modules = Object.keys(this.modules)) {
		// To perform operations in sequence and not using bluebird

		// eslint-disable-next-line no-restricted-syntax
		for (const alias of modules) {
			// eslint-disable-next-line no-await-in-loop
			await this.modules[alias].unload();
			delete this.modules[alias];
		}
	}

	async cleanup(code, reason) {
		this.logger.info('Cleanup controller...');

		if (reason) {
			this.logger.error(`Reason: ${reason}`);
		}

		this.childrenList.forEach(child => child.kill());

		try {
			await this.bus.cleanup();
			await this.unloadModules();
			this.logger.info('Unload completed');
		} catch (error) {
			this.logger.error('Caused error during cleanup', error);
		}
	}
}

module.exports = Controller;