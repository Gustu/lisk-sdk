/*
 * Copyright © 2019 Lisk Foundation
 *
 * See the LICENSE file at the top-level directory of this distribution
 * for licensing information.
 *
 * Unless otherwise agreed in a custom licensing agreement with the Lisk Foundation,
 * no part of this software, including this file, may be copied, modified,
 * propagated, or distributed except according to the terms contained in the
 * LICENSE file.
 *
 * Removal or modification of this copyright notice is prohibited.
 */

'use strict';

const { getNetworkIdentifier } = require('@liskhq/lisk-cryptography');
const { convertErrorsToString } = require('./utils/error_handlers');
const { Sequence } = require('./utils/sequence');
const { createStorageComponent } = require('../../components/storage');
const { createLoggerComponent } = require('../../components/logger');
const { bootstrapStorage } = require('./init_steps');
const jobQueue = require('./utils/jobs_queue');
const {
	TransactionPool,
	EVENT_MULTISIGNATURE_SIGNATURE,
	EVENT_UNCONFIRMED_TRANSACTION,
} = require('./transaction_pool');
const {
	Slots,
	Dpos,
	constants: { EVENT_ROUND_CHANGED },
} = require('./dpos');
const { EVENT_BFT_BLOCK_FINALIZED, BFT } = require('./bft');
const { Blocks } = require('./blocks');
const { Loader } = require('./loader');
const { Forger } = require('./forger');
const { Transport } = require('./transport');
const {
	Synchronizer,
	BlockSynchronizationMechanism,
	FastChainSwitchingMechanism,
} = require('./synchronizer');
const { Processor } = require('./processor');
const { Rebuilder } = require('./rebuilder');
const { BlockProcessorV0 } = require('./block_processor_v0.js');
const { BlockProcessorV1 } = require('./block_processor_v1.js');
const { BlockProcessorV2 } = require('./block_processor_v2.js');

const forgeInterval = 1000;

module.exports = class Chain {
	constructor(channel, options) {
		this.channel = channel;
		this.options = options;
		this.logger = null;
		this.scope = null;
		this.slots = null;
	}

	async bootstrap() {
		const loggerConfig = await this.channel.invoke(
			'app:getComponentConfig',
			'logger',
		);

		const storageConfig = await this.channel.invoke(
			'app:getComponentConfig',
			'storage',
		);

		this.applicationState = await this.channel.invoke(
			'app:getApplicationState',
		);

		this.logger = createLoggerComponent({ ...loggerConfig, module: 'chain' });
		const dbLogger =
			storageConfig.logFileName &&
			storageConfig.logFileName === loggerConfig.logFileName
				? this.logger
				: createLoggerComponent({
						...loggerConfig,
						logFileName: storageConfig.logFileName,
						module: 'chain:database',
				  });

		global.constants = this.options.constants;
		global.exceptions = this.options.exceptions;

		try {
			if (!this.options.genesisBlock) {
				throw Error('Failed to assign nethash from genesis block');
			}

			if (
				this.options.forging.waitThreshold >= this.options.constants.BLOCK_TIME
			) {
				throw Error(
					`modules.chain.forging.waitThreshold=${
						this.options.forging.waitThreshold
					} is greater or equal to app.genesisConfig.BLOCK_TIME=${
						this.options.constants.BLOCK_TIME
					}. It impacts the forging and propagation of blocks. Please use a smaller value for modules.chain.forging.waitThreshold`,
				);
			}

			// Storage
			this.logger.debug('Initiating storage...');
			this.storage = createStorageComponent(storageConfig, dbLogger);

			// TODO: For socket cluster child process, should be removed with refactoring of network module
			this.options.loggerConfig = loggerConfig;

			this.networkIdentifier = getNetworkIdentifier(
				this.options.genesisBlock.payloadHash,
				this.options.genesisBlock.communityIdentifier,
			);

			const self = this;
			this.scope = {
				config: self.options,
				genesisBlock: { block: self.options.genesisBlock },
				registeredTransactions: self.options.registeredTransactions,
				sequence: new Sequence({
					onWarning(current) {
						self.logger.warn('Main queue', current);
					},
				}),
				components: {
					storage: this.storage,
					logger: this.logger,
				},
				channel: this.channel,
				applicationState: this.applicationState,
			};

			await bootstrapStorage(this.scope, global.constants.ACTIVE_DELEGATES);

			await this._initModules();

			// Prepare dependency
			const processorDependencies = {
				blocksModule: this.blocks,
				bftModule: this.bft,
				dposModule: this.dpos,
				storage: this.storage,
				logger: this.logger,
				constants: this.options.constants,
				exceptions: this.options.exceptions,
			};

			// TODO: Move this to core https://github.com/LiskHQ/lisk-sdk/issues/4140
			if (this.options.exceptions.blockVersions) {
				if (this.options.exceptions.blockVersions[0]) {
					const period = this.options.exceptions.blockVersions[0];
					this.processor.register(new BlockProcessorV0(processorDependencies), {
						matcher: ({ height }) =>
							height >= period.start && height <= period.end,
					});
				}

				if (this.options.exceptions.blockVersions[1]) {
					const period = this.options.exceptions.blockVersions[1];
					this.processor.register(new BlockProcessorV1(processorDependencies), {
						matcher: ({ height }) =>
							height >= period.start && height <= period.end,
					});
				}
			}

			this.processor.register(new BlockProcessorV2(processorDependencies));

			// Deserialize genesis block and overwrite the options
			this.options.genesisBlock = await this.processor.deserialize(
				this.options.genesisBlock,
			);

			// Deactivate broadcast and syncing during snapshotting process
			if (this.options.loading.rebuildUpToRound) {
				this.options.broadcasts.active = false;
				this.options.syncing.active = false;
				await this.rebuilder.rebuild(
					this.options.loading.rebuildUpToRound,
					this.options.loading.loadPerIteration,
				);
				this.logger.info(
					{
						rebuildUpToRound: this.options.loading.rebuildUpToRound,
						loadPerIteration: this.options.loading.loadPerIteration,
					},
					'Successfully rebuild the blockchain',
				);
				process.emit('cleanup');
				return;
			}

			this.channel.subscribe('app:state:updated', event => {
				Object.assign(this.scope.applicationState, event.data);
			});

			this.logger.info('Modules ready and launched');
			// After binding, it should immediately load blockchain
			await this.processor.init(this.options.genesisBlock);

			// Update Application State after processor is initialized
			this.channel.invoke('app:updateApplicationState', {
				height: this.blocks.lastBlock.height,
				lastBlockId: this.blocks.lastBlock.id,
				maxHeightPrevoted: this.blocks.lastBlock.maxHeightPrevoted || 0,
				blockVersion: this.blocks.lastBlock.version,
			});

			this._subscribeToEvents();

			this.channel.subscribe('network:bootstrap', async () => {
				await this._startForging();
			});

			this.channel.subscribe('network:ready', async () => {
				this._startLoader();
			});

			// Avoid receiving blocks/transactions from the network during snapshotting process
			if (!this.options.loading.rebuildUpToRound) {
				this.channel.subscribe(
					'network:event',
					async ({ data: { event, data, peerId } }) => {
						try {
							if (event === 'postTransactionsAnnouncement') {
								await this.transport.handleEventPostTransactionsAnnouncement(
									data,
									peerId,
								);
								return;
							}
							if (event === 'postSignatures') {
								await this.transport.handleEventPostSignatures(data, peerId);
								return;
							}
							if (event === 'postBlock') {
								await this.transport.handleEventPostBlock(data, peerId);
								return;
							}
						} catch (err) {
							this.logger.warn(
								{ err, event },
								'Received invalid event message',
							);
						}
					},
				);
			}

			// Check if blocks are left in temp_block table
			await this.synchronizer.init();
		} catch (error) {
			this.logger.fatal(
				{
					message: error.message,
					stack: error.stack,
				},
				'Failed to initialization chain module',
			);
			process.emit('cleanup', error);
		}
	}

	get actions() {
		return {
			calculateSupply: action =>
				this.blocks.blockReward.calculateSupply(action.params.height),
			calculateMilestone: action =>
				this.blocks.blockReward.calculateMilestone(action.params.height),
			calculateReward: action =>
				this.blocks.blockReward.calculateReward(action.params.height),
			getForgerPublicKeysForRound: async action =>
				this.dpos.getForgerPublicKeysForRound(action.params.round),
			updateForgingStatus: async action =>
				this.forger.updateForgingStatus(
					action.params.publicKey,
					action.params.password,
					action.params.forging,
				),
			getTransactions: async action =>
				this.transport.handleRPCGetTransactions(
					action.params.data,
					action.params.peerId,
				),
			getSignatures: async () => this.transport.handleRPCGetSignatures(),
			postSignature: async action =>
				this.transport.handleEventPostSignature(action.params),
			getForgingStatusForAllDelegates: async () =>
				this.forger.getForgingStatusForAllDelegates(),
			getTransactionsFromPool: async ({ params }) =>
				this.transactionPool.getPooledTransactions(params.type, params.filters),
			postTransaction: async action =>
				this.transport.handleEventPostTransaction(action.params),
			getSlotNumber: async action =>
				action.params
					? this.slots.getSlotNumber(action.params.epochTime)
					: this.slots.getSlotNumber(),
			calcSlotRound: async action => this.slots.calcRound(action.params.height),
			getNodeStatus: async () => ({
				syncing: this.synchronizer.isActive,
				unconfirmedTransactions: this.transactionPool.getCount(),
				secondsSinceEpoch: this.slots.getEpochTime(),
				lastBlock: this.blocks.lastBlock,
				chainMaxHeightFinalized: this.bft.finalityManager.finalizedHeight,
			}),
			getLastBlock: async () => this.processor.serialize(this.blocks.lastBlock),
			getBlocksFromId: async action =>
				this.transport.handleRPCGetBlocksFromId(
					action.params.data,
					action.params.peerId,
				),
			getHighestCommonBlock: async action =>
				this.transport.handleRPCGetGetHighestCommonBlock(
					action.params.data,
					action.params.peerId,
				),
		};
	}

	async cleanup(error) {
		this._unsubscribeToEvents();
		const { modules, components } = this.scope;
		if (error) {
			this.logger.fatal(error.toString());
		}
		this.logger.info('Cleaning chain...');

		if (components !== undefined) {
			Object.keys(components).forEach(async key => {
				if (components[key].cleanup) {
					await components[key].cleanup();
				}
			});
		}

		// Run cleanup operation on each module before shutting down the node;
		// this includes operations like the rebuild verification process.
		await Promise.all(
			Object.keys(modules).map(key => {
				if (typeof modules[key].cleanup === 'function') {
					return modules[key].cleanup();
				}
				return true;
			}),
		).catch(moduleCleanupError => {
			this.logger.error(convertErrorsToString(moduleCleanupError));
		});

		this.logger.info('Cleaned up successfully');
	}

	async _initModules() {
		this.scope.modules = {};
		this.slots = new Slots({
			epochTime: this.options.constants.EPOCH_TIME,
			interval: this.options.constants.BLOCK_TIME,
			blocksPerRound: this.options.constants.ACTIVE_DELEGATES,
		});
		this.scope.slots = this.slots;
		this.bft = new BFT({
			storage: this.storage,
			logger: this.logger,
			slots: this.slots,
			activeDelegates: this.options.constants.ACTIVE_DELEGATES,
			startingHeight: 0, // TODO: Pass exception precedent from config or height for block version 2
		});
		this.dpos = new Dpos({
			storage: this.storage,
			logger: this.logger,
			slots: this.slots,
			activeDelegates: this.options.constants.ACTIVE_DELEGATES,
			delegateListRoundOffset: this.options.constants
				.DELEGATE_LIST_ROUND_OFFSET,
			exceptions: this.options.exceptions,
		});

		this.dpos.events.on(EVENT_ROUND_CHANGED, data => {
			this.channel.publish('chain:rounds:change', { number: data.newRound });
		});

		this.blocks = new Blocks({
			logger: this.logger,
			storage: this.storage,
			sequence: this.scope.sequence,
			genesisBlock: this.options.genesisBlock,
			registeredTransactions: this.options.registeredTransactions,
			networkIdentifier: this.networkIdentifier,
			slots: this.slots,
			exceptions: this.options.exceptions,
			blockReceiptTimeout: this.options.constants.BLOCK_RECEIPT_TIMEOUT,
			loadPerIteration: 1000,
			maxPayloadLength: this.options.constants.MAX_PAYLOAD_LENGTH,
			maxTransactionsPerBlock: this.options.constants
				.MAX_TRANSACTIONS_PER_BLOCK,
			activeDelegates: this.options.constants.ACTIVE_DELEGATES,
			rewardDistance: this.options.constants.REWARDS.DISTANCE,
			rewardOffset: this.options.constants.REWARDS.OFFSET,
			rewardMileStones: this.options.constants.REWARDS.MILESTONES,
			totalAmount: this.options.constants.TOTAL_AMOUNT,
			blockSlotWindow: this.options.constants.BLOCK_SLOT_WINDOW,
		});
		this.processor = new Processor({
			channel: this.channel,
			logger: this.logger,
			storage: this.storage,
			blocksModule: this.blocks,
		});
		const blockSyncMechanism = new BlockSynchronizationMechanism({
			storage: this.storage,
			logger: this.logger,
			bft: this.bft,
			slots: this.slots,
			channel: this.channel,
			blocks: this.blocks,
			activeDelegates: this.options.constants.ACTIVE_DELEGATES,
			processorModule: this.processor,
		});

		const fastChainSwitchMechanism = new FastChainSwitchingMechanism({
			storage: this.storage,
			logger: this.logger,
			channel: this.channel,
			slots: this.slots,
			blocks: this.blocks,
			bft: this.bft,
			dpos: this.dpos,
			processor: this.processor,
			activeDelegates: this.options.constants.ACTIVE_DELEGATES,
		});

		this.synchronizer = new Synchronizer({
			logger: this.logger,
			blocksModule: this.blocks,
			processorModule: this.processor,
			storageModule: this.storage,
			mechanisms: [blockSyncMechanism, fastChainSwitchMechanism],
		});

		this.scope.modules.blocks = this.blocks;
		this.transactionPool = new TransactionPool({
			logger: this.logger,
			storage: this.storage,
			blocks: this.blocks,
			slots: this.slots,
			exceptions: this.options.exceptions,
			maxTransactionsPerQueue: this.options.transactions
				.maxTransactionsPerQueue,
			expireTransactionsInterval: this.options.constants.EXPIRY_INTERVAL,
			maxTransactionsPerBlock: this.options.constants
				.MAX_TRANSACTIONS_PER_BLOCK,
			maxSharedTransactions: this.options.constants.MAX_SHARED_TRANSACTIONS,
			broadcastInterval: this.options.broadcasts.broadcastInterval,
			releaseLimit: this.options.broadcasts.releaseLimit,
		});
		this.scope.modules.transactionPool = this.transactionPool;
		this.loader = new Loader({
			channel: this.channel,
			logger: this.logger,
			processorModule: this.processor,
			transactionPoolModule: this.transactionPool,
			blocksModule: this.blocks,
			loadPerIteration: this.options.loading.loadPerIteration,
			syncingActive: this.options.syncing.active,
		});
		this.rebuilder = new Rebuilder({
			channel: this.channel,
			logger: this.logger,
			storage: this.storage,
			genesisBlock: this.options.genesisBlock,
			blocksModule: this.blocks,
			processorModule: this.processor,
			activeDelegates: this.options.constants.ACTIVE_DELEGATES,
		});
		this.scope.modules.rebuilder = this.rebuilder;
		this.forger = new Forger({
			channel: this.channel,
			logger: this.logger,
			storage: this.storage,
			slots: this.slots,
			dposModule: this.dpos,
			transactionPoolModule: this.transactionPool,
			processorModule: this.processor,
			blocksModule: this.blocks,
			activeDelegates: this.options.constants.ACTIVE_DELEGATES,
			maxTransactionsPerBlock: this.options.constants
				.MAX_TRANSACTIONS_PER_BLOCK,
			forgingDelegates: this.options.forging.delegates,
			forgingForce: this.options.forging.force,
			forgingDefaultPassword: this.options.forging.defaultPassword,
			forgingWaitThreshold: this.options.forging.waitThreshold,
		});
		this.transport = new Transport({
			channel: this.channel,
			logger: this.logger,
			storage: this.storage,
			synchronizer: this.synchronizer,
			applicationState: this.applicationState,
			exceptions: this.options.exceptions,
			transactionPoolModule: this.transactionPool,
			processorModule: this.processor,
			blocksModule: this.blocks,
			loaderModule: this.loader,
			broadcasts: this.options.broadcasts,
			maxSharedTransactions: this.options.constants.MAX_SHARED_TRANSACTIONS,
		});
		// TODO: should not add to scope
		this.scope.modules.loader = this.loader;
		this.scope.modules.forger = this.forger;
		this.scope.modules.transport = this.transport;
		this.scope.modules.bft = this.bft;
		this.scope.modules.synchronizer = this.synchronizer;
	}

	_startLoader() {
		this.loader.loadUnconfirmedTransactions();
	}

	async _forgingTask() {
		return this.scope.sequence.add(async () => {
			try {
				if (!this.forger.delegatesEnabled()) {
					this.logger.debug('No delegates are enabled');
					return;
				}
				if (this.synchronizer.isActive) {
					this.logger.debug('Client not ready to forge');
					return;
				}
				await this.forger.beforeForge();
				await this.forger.forge();
			} catch (err) {
				this.logger.error({ err });
			}
		});
	}

	async _startForging() {
		try {
			await this.forger.loadDelegates();
		} catch (err) {
			this.logger.error({ err }, 'Failed to load delegates for forging');
		}
		jobQueue.register(
			'nextForge',
			async () => this._forgingTask(),
			forgeInterval,
		);
	}

	_subscribeToEvents() {
		this.channel.subscribe(
			'chain:processor:broadcast',
			async ({ data: { block } }) => {
				await this.transport.handleBroadcastBlock(block);
			},
		);

		this.channel.subscribe(
			'chain:processor:deleteBlock',
			({ data: { block } }) => {
				if (block.transactions.length) {
					const transactions = block.transactions
						.reverse()
						.map(tx => this.blocks.deserializeTransaction(tx));
					this.transactionPool.onDeletedTransactions(transactions);
					this.channel.publish(
						'chain:transactions:confirmed:change',
						block.transactions,
					);
				}
				this.logger.info(
					{ id: block.id, height: block.height },
					'Deleted a block from the chain',
				);
				this.channel.publish('chain:blocks:change', block);
			},
		);

		this.channel.subscribe(
			'chain:processor:newBlock',
			({ data: { block } }) => {
				if (block.transactions.length) {
					this.transactionPool.onConfirmedTransactions(
						block.transactions.map(tx =>
							this.blocks.deserializeTransaction(tx),
						),
					);
					this.channel.publish(
						'chain:transactions:confirmed:change',
						block.transactions,
					);
				}
				this.logger.info(
					{
						id: block.id,
						height: block.height,
						numberOfTransactions: block.transactions.length,
					},
					'New block added to the chain',
				);
				this.channel.publish('chain:blocks:change', block);

				if (!this.synchronizer.isActive) {
					this.channel.invoke('app:updateApplicationState', {
						height: block.height,
						lastBlockId: block.id,
						maxHeightPrevoted: block.maxHeightPrevoted,
						blockVersion: block.version,
					});
				}
			},
		);

		this.channel.subscribe(
			'chain:processor:sync',
			({ data: { block, peerId } }) => {
				this.synchronizer.run(block, peerId).catch(err => {
					this.logger.error({ err }, 'Error occurred during synchronization.');
				});
			},
		);

		this.transactionPool.on(EVENT_UNCONFIRMED_TRANSACTION, transaction => {
			this.logger.trace(
				{ transactionId: transaction.id },
				'Received EVENT_UNCONFIRMED_TRANSACTION',
			);
			this.transport.handleBroadcastTransaction(transaction);
		});

		this.bft.on(EVENT_BFT_BLOCK_FINALIZED, ({ height }) => {
			this.dpos.onBlockFinalized({ height });
		});

		this.transactionPool.on(EVENT_MULTISIGNATURE_SIGNATURE, signature => {
			this.logger.trace(
				{ signature },
				'Received EVENT_MULTISIGNATURE_SIGNATURE',
			);
			this.transport.handleBroadcastSignature(signature);
		});
	}

	_unsubscribeToEvents() {
		this.bft.removeAllListeners(EVENT_BFT_BLOCK_FINALIZED);
		this.blocks.removeAllListeners(EVENT_UNCONFIRMED_TRANSACTION);
		this.blocks.removeAllListeners(EVENT_MULTISIGNATURE_SIGNATURE);
	}
};
