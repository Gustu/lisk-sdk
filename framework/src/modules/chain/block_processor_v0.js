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

const BigNum = require('@liskhq/bignum');
const {
	BIG_ENDIAN,
	hash,
	hexToBuffer,
	intToBuffer,
	LITTLE_ENDIAN,
	signDataWithPrivateKey,
} = require('@liskhq/lisk-cryptography');
const { validator } = require('@liskhq/lisk-validator');
const { BaseBlockProcessor } = require('./processor');
const { baseBlockSchema } = require('./blocks');

const SIZE_INT32 = 4;
const SIZE_INT64 = 8;

const getBytes = block => {
	const blockVersionBuffer = intToBuffer(
		block.version,
		SIZE_INT32,
		LITTLE_ENDIAN,
	);

	const timestampBuffer = intToBuffer(
		block.timestamp,
		SIZE_INT32,
		LITTLE_ENDIAN,
	);

	const previousBlockBuffer = block.previousBlockId
		? intToBuffer(block.previousBlockId, SIZE_INT64, BIG_ENDIAN)
		: Buffer.alloc(SIZE_INT64);

	const numTransactionsBuffer = intToBuffer(
		block.numberOfTransactions,
		SIZE_INT32,
		LITTLE_ENDIAN,
	);

	const totalAmountBuffer = intToBuffer(
		block.totalAmount.toString(),
		SIZE_INT64,
		LITTLE_ENDIAN,
	);

	const totalFeeBuffer = intToBuffer(
		block.totalFee.toString(),
		SIZE_INT64,
		LITTLE_ENDIAN,
	);

	const rewardBuffer = intToBuffer(
		block.reward.toString(),
		SIZE_INT64,
		LITTLE_ENDIAN,
	);

	const payloadLengthBuffer = intToBuffer(
		block.payloadLength,
		SIZE_INT32,
		LITTLE_ENDIAN,
	);

	const payloadHashBuffer = hexToBuffer(block.payloadHash);

	const generatorPublicKeyBuffer = hexToBuffer(block.generatorPublicKey);

	const blockSignatureBuffer = block.blockSignature
		? hexToBuffer(block.blockSignature)
		: Buffer.alloc(0);

	return Buffer.concat([
		blockVersionBuffer,
		timestampBuffer,
		previousBlockBuffer,
		numTransactionsBuffer,
		totalAmountBuffer,
		totalFeeBuffer,
		rewardBuffer,
		payloadLengthBuffer,
		payloadHashBuffer,
		generatorPublicKeyBuffer,
		blockSignatureBuffer,
	]);
};

const validateSchema = ({ block }) => {
	const errors = validator.validate(baseBlockSchema, block);
	if (errors.length) {
		throw errors;
	}
};

class BlockProcessorV0 extends BaseBlockProcessor {
	constructor({
		blocksModule,
		dposModule,
		bftModule,
		logger,
		constants,
		exceptions,
	}) {
		super();
		const delegateListRoundOffset = 0;
		this.blocksModule = blocksModule;
		this.dposModule = dposModule;
		this.bftModule = bftModule;
		this.logger = logger;
		this.constants = constants;
		this.exceptions = exceptions;

		this.deserialize.pipe([
			({ block }) => this.blocksModule.deserialize(block),
			(_, updatedBlock) => ({
				...updatedBlock,
				maxHeightPreviouslyForged:
					updatedBlock.maxHeightPreviouslyForged || updatedBlock.height,
				maxHeightPrevoted: updatedBlock.maxHeightPrevoted || 0,
			}),
		]);

		this.serialize.pipe([({ block }) => this.blocksModule.serialize(block)]);

		this.validate.pipe([
			data => this._validateVersion(data),
			data => validateSchema(data),
			({ block }) =>
				this.blocksModule.blockReward.calculateReward(block.height),
			({ block }, expectedReward) =>
				this.blocksModule.validateBlockHeader(
					block,
					getBytes(block),
					expectedReward,
				),
			({ block, lastBlock }) =>
				this.blocksModule.verifyInMemory(block, lastBlock),
			({ block }) =>
				this.dposModule.verifyBlockForger(block, { delegateListRoundOffset }),
		]);

		this.validateDetached.pipe([
			data => this._validateVersion(data),
			data => validateSchema(data),
			({ block }) =>
				this.blocksModule.blockReward.calculateReward(block.height),
			({ block }, expectedReward) =>
				this.blocksModule.validateBlockHeader(
					block,
					getBytes(block),
					expectedReward,
				),
		]);

		this.forkStatus.pipe([
			({ block, lastBlock }) => this.bftModule.forkChoice(block, lastBlock), // validate common block header
		]);

		this.verify.pipe([
			({ block, stateStore, skipExistingCheck }) =>
				this.blocksModule.verify(block, stateStore, { skipExistingCheck }),
		]);

		this.apply.pipe([
			({ block, stateStore }) => this.blocksModule.apply(block, stateStore),
			({ block, tx }) =>
				this.dposModule.apply(block, { tx, delegateListRoundOffset }),
		]);

		this.applyGenesis.pipe([
			({ block, stateStore }) =>
				this.blocksModule.applyGenesis(block, stateStore),
			({ block, tx }) =>
				this.dposModule.apply(block, { tx, delegateListRoundOffset }),
		]);

		this.undo.pipe([
			({ block, stateStore }) => this.blocksModule.undo(block, stateStore),
			({ block, tx }) =>
				this.dposModule.undo(block, { tx, delegateListRoundOffset }),
		]);

		this.create.pipe([data => this._create(data)]);
	}

	// eslint-disable-next-line class-methods-use-this
	get version() {
		return 0;
	}

	async _create({ transactions, previousBlock, keypair, timestamp }) {
		const nextHeight = previousBlock ? previousBlock.height + 1 : 1;
		const reward = this.blocksModule.blockReward.calculateReward(nextHeight);
		let totalFee = new BigNum(0);
		let totalAmount = new BigNum(0);
		let size = 0;

		const trs = transactions || [];
		const blockTransactions = [];
		const transactionsBytesArray = [];

		// eslint-disable-next-line no-restricted-syntax
		for (const transaction of trs) {
			const transactionBytes = transaction.getBytes(transaction);

			if (size + transactionBytes.length > this.constants.maxPayloadLength) {
				break;
			}

			size += transactionBytes.length;

			totalFee = totalFee.plus(transaction.fee);
			totalAmount = totalAmount.plus(transaction.asset.amount || 0);

			blockTransactions.push(transaction);
			transactionsBytesArray.push(transactionBytes);
		}

		const transactionsBuffer = Buffer.concat(transactionsBytesArray);
		const payloadHash = hash(transactionsBuffer).toString('hex');

		const block = {
			version: this.version,
			totalAmount,
			totalFee,
			height: nextHeight,
			reward,
			payloadHash,
			timestamp,
			numberOfTransactions: blockTransactions.length,
			payloadLength: size,
			previousBlockId: previousBlock.id,
			generatorPublicKey: keypair.publicKey.toString('hex'),
			transactions: blockTransactions,
		};

		return {
			...block,
			blockSignature: signDataWithPrivateKey(
				hash(getBytes(block)),
				keypair.privateKey,
			),
		};
	}
}

module.exports = {
	BlockProcessorV0,
};
