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

const {
	decryptPassphraseWithPassword,
	parseEncryptedPassphrase,
	getAddressFromPrivateKey,
	getPrivateAndPublicKeyFromPassphrase,
} = require('@liskhq/lisk-cryptography');

const BaseGenerator = require('../base_generator');
const defaultConfig = require('../../config/devnet');
const genesisDelegateAccounts = require('../../config/devnet_genesis_delegates');

const ChainStateBuilder = require('../../utils/chain_state_builder');

const { genesisBlock } = defaultConfig;

// Computed within Client application
// TODO: Compute the initial account state here
const initialAccountsState = [
	{
		address: '11036225455433466506L',
		publicKey:
			'd13a2659f908146f099da29216a18fd7f845b4e1455087b1a4bced79b6fefadf',
		balance: '1000000000000',
		secondSignature: 0,
		isDelegate: 0,
		vote: '0',
		multimin: 0,
		multilifetime: 0,
		nameexist: 0,
		producedBlocks: 0,
		missedBlocks: 0,
		fees: '0',
		rewards: '0',
		asset: {},
		voteWeight: '0',
	},
	...genesisDelegateAccounts,
];

// Object holding the genesis account information and passphrase as well as
// an existing delegate account for DEVNET
// TODO: Move this to devnet.json config file.
const accounts = {
	// Genesis account, initially holding 100M total supply
	genesis: {
		address: '11036225455433466506L',
		publicKey:
			'd13a2659f908146f099da29216a18fd7f845b4e1455087b1a4bced79b6fefadf',
		passphrase:
			'amazing rose void lion bamboo maid electric involve feed way popular actor',
		balance: '10000000000000000',
		encryptedPassphrase:
			'iterations=1&cipherText=efd726ad67973f374caeda0f715571974789b99e70aa961129f295aa8e4c8d0bb39e321402fbcc126e8bf8630e17c13c4743702cd10343777ba17e443b7d444a76560538030e459afb3e&iv=8654394f37d831abdc5181be&salt=bbeee4479ae011704151acb23f0a889d&tag=44a42e50eb8bdc183fe68161856055b1&version=1',
		password: 'elephant tree paris dragon chair galaxy',
	},
	votingAccount: {
		passphrase:
			'blame address tube insect cost knock major level regret bring april stick',
		privateKey:
			'b92e223981770c716ee54192a0ad028639d28d41221b72e455447bc4767aeb94caff2242b740a733daa3f3f96fc1592303b60c1704a8ac626e2704da039f41ee',
		publicKey:
			'caff2242b740a733daa3f3f96fc1592303b60c1704a8ac626e2704da039f41ee',
		address: '2222471382442610527L',
		balance: '0',
	},
};

// Decrypt all passwords from delegate genesis and add to accounts array
// eslint-disable-next-line no-restricted-syntax
for (const anAccount of genesisDelegateAccounts) {
	const { encryptedPassphrase } = defaultConfig.forging.delegates.find(
		aDelegate => aDelegate.publicKey === anAccount.publicKey,
	);

	const passphrase = decryptPassphraseWithPassword(
		parseEncryptedPassphrase(encryptedPassphrase),
		defaultConfig.forging.defaultPassword,
	);
	const keys = getPrivateAndPublicKeyFromPassphrase(passphrase);
	const address = getAddressFromPrivateKey(keys.privateKey);

	accounts[`${anAccount.username}_delegate`] = {
		passphrase,
		privateKey: keys.privateKey,
		publicKey: keys.publicKey,
		address,
		balance: '0',
	};
}

// Generators
const generateTestCasesValidBlockVotesTx = () => {
	const chainStateBuilder = new ChainStateBuilder(
		genesisBlock,
		initialAccountsState,
		accounts,
	);

	// Give balance from genesis account to delegates just for having account states to compare against
	// As the state builder is pretty basic so far we need to control forging only 25 transactions like this.
	let transactionCount = 0;
	// eslint-disable-next-line no-restricted-syntax
	for (const anAccount of genesisDelegateAccounts) {
		if (transactionCount === 25) {
			chainStateBuilder.forge();
			transactionCount = 0;
		}
		transactionCount += 1;

		chainStateBuilder
			.transfer('99')
			.from('11036225455433466506L')
			.to(anAccount.address);
	}
	// Fund account that will issue votes
	chainStateBuilder
		.transfer('101')
		.from('11036225455433466506L')
		.to('2222471382442610527L');

	// Forge the block so as to have all delegates in the store
	chainStateBuilder.forge();

	// Vote for the 101 delegates with one account
	chainStateBuilder
		.castVotesFrom('2222471382442610527L')
		.voteDelegates(
			genesisDelegateAccounts
				.slice(0, 33)
				.map(aDelegate => aDelegate.publicKey),
		)
		.unvoteDelegates([]);

	chainStateBuilder
		.castVotesFrom('2222471382442610527L')
		.voteDelegates(
			genesisDelegateAccounts
				.slice(33, 66)
				.map(aDelegate => aDelegate.publicKey),
		)
		.unvoteDelegates([]);

	chainStateBuilder
		.castVotesFrom('2222471382442610527L')
		.voteDelegates(
			genesisDelegateAccounts
				.slice(66, 99)
				.map(aDelegate => aDelegate.publicKey),
		)
		.unvoteDelegates([]);

	chainStateBuilder
		.castVotesFrom('2222471382442610527L')
		.voteDelegates(
			genesisDelegateAccounts
				.slice(99, 101)
				.map(aDelegate => aDelegate.publicKey),
		)
		.unvoteDelegates([]);

	chainStateBuilder.forge();

	const chainAndAccountStates = chainStateBuilder.getScenario();
	return {
		initialState: {
			// Given the library chainStateBuilder saves all mutations we use slice here to pick the first accounts state
			chain: chainAndAccountStates.chain.slice(0, 5),
			accounts: chainAndAccountStates.initialAccountsState,
		},
		input: chainAndAccountStates.chain.slice(-1),
		output: {
			chain: chainAndAccountStates.chain,
			// Given the library chainStateBuilder saves all mutations we use slice here to pick the last account state
			accounts: chainAndAccountStates.finalAccountsState.slice(-1),
		},
	};
};

const generateTestCasesInvalidBlockTooManyVotesTx = () => {
	const chainStateBuilder = new ChainStateBuilder(
		genesisBlock,
		initialAccountsState,
		accounts,
	);

	// Give balance from genesis account to delegates just for having account states to compare against
	// As the state builder is pretty basic so far we need to control forging only 25 transactions like this.
	let transactionCount = 0;
	// eslint-disable-next-line no-restricted-syntax
	for (const anAccount of genesisDelegateAccounts) {
		if (transactionCount === 25) {
			chainStateBuilder.forge();
			transactionCount = 0;
		}
		transactionCount += 1;

		chainStateBuilder
			.transfer('99')
			.from('11036225455433466506L')
			.to(anAccount.address);
	}
	// Fund account that will issue votes
	chainStateBuilder
		.transfer('101')
		.from('11036225455433466506L')
		.to('2222471382442610527L');

	// Forge the block so as to have all delegates in the store
	chainStateBuilder.forge();

	// Vote for the 101 delegates with one account
	chainStateBuilder
		.castVotesFrom('2222471382442610527L')
		.voteDelegates(
			genesisDelegateAccounts.map(aDelegate => aDelegate.publicKey),
		)
		.unvoteDelegates([]);

	chainStateBuilder.forgeInvalidInputBlock();

	const chainAndAccountStates = chainStateBuilder.getScenario();

	return {
		initialState: {
			// Given the library chainStateBuilder saves all mutations we use slice here to pick the first accounts state
			chain: chainAndAccountStates.chain,
			accounts: chainAndAccountStates.initialAccountsState,
		},
		input: chainAndAccountStates.inputBlock,
		output: {
			chain: chainAndAccountStates.chain,
			// Given the library chainStateBuilder saves all mutations we use slice here to pick the last account state
			accounts: chainAndAccountStates.finalAccountsState.slice(-1),
		},
	};
};

const generateTestCasesInvalidBlockVoteNoDelegateTx = () => {
	const chainStateBuilder = new ChainStateBuilder(
		genesisBlock,
		initialAccountsState,
		accounts,
	);

	// Give balance from genesis account to delegates just for having account states to compare against
	// As the state builder is pretty basic so far we need to control forging only 25 transactions like this.
	let transactionCount = 0;
	// eslint-disable-next-line no-restricted-syntax
	for (const anAccount of genesisDelegateAccounts) {
		if (transactionCount === 25) {
			chainStateBuilder.forge();
			transactionCount = 0;
		}
		transactionCount += 1;

		chainStateBuilder
			.transfer('99')
			.from('11036225455433466506L')
			.to(anAccount.address);
	}
	// Fund account that will issue votes
	chainStateBuilder
		.transfer('101')
		.from('11036225455433466506L')
		.to('2222471382442610527L');

	// Forge the block so as to have all delegates in the store
	chainStateBuilder.forge();

	const notAdelegate = ChainStateBuilder.createAccount();
	// Vote for an account is not a delegate
	chainStateBuilder
		.castVotesFrom('2222471382442610527L')
		.voteDelegates([notAdelegate.publicKey])
		.unvoteDelegates([]);

	chainStateBuilder.forgeInvalidInputBlock();

	const chainAndAccountStates = chainStateBuilder.getScenario();

	return {
		initialState: {
			// Given the library chainStateBuilder saves all mutations we use slice here to pick the first accounts state
			chain: chainAndAccountStates.chain,
			accounts: chainAndAccountStates.initialAccountsState,
		},
		input: chainAndAccountStates.inputBlock,
		output: {
			chain: chainAndAccountStates.chain,
			// Given the library chainStateBuilder saves all mutations we use slice here to pick the last account state
			accounts: chainAndAccountStates.finalAccountsState.slice(-1),
		},
	};
};

const generateTestCasesInvalidBlockVoteAlreadyVotedDelegateTx = () => {
	const chainStateBuilder = new ChainStateBuilder(
		genesisBlock,
		initialAccountsState,
		accounts,
	);

	// Give balance from genesis account to delegates just for having account states to compare against
	// As the state builder is pretty basic so far we need to control forging only 25 transactions like this.
	let transactionCount = 0;
	// eslint-disable-next-line no-restricted-syntax
	for (const anAccount of genesisDelegateAccounts) {
		if (transactionCount === 25) {
			chainStateBuilder.forge();
			transactionCount = 0;
		}
		transactionCount += 1;

		chainStateBuilder
			.transfer('99')
			.from('11036225455433466506L')
			.to(anAccount.address);
	}
	// Fund account that will issue votes
	chainStateBuilder
		.transfer('101')
		.from('11036225455433466506L')
		.to('2222471382442610527L');

	// Forge the block so as to have all delegates in the store
	chainStateBuilder.forge();
	// Vote for an account is not a delegate
	chainStateBuilder
		.castVotesFrom('2222471382442610527L')
		.voteDelegates([
			'1cc68fa0b12521158e09779fd5978ccc0ac26bf99320e00a9549b542dd9ada16',
		])
		.unvoteDelegates([]);

	chainStateBuilder.forgeInvalidInputBlock();

	const chainAndAccountStates = chainStateBuilder.getScenario();

	return {
		initialState: {
			// Given the library chainStateBuilder saves all mutations we use slice here to pick the first accounts state
			chain: chainAndAccountStates.chain,
			accounts: chainAndAccountStates.initialAccountsState,
		},
		input: chainAndAccountStates.inputBlock,
		output: {
			chain: chainAndAccountStates.chain,
			// Given the library chainStateBuilder saves all mutations we use slice here to pick the last account state
			accounts: chainAndAccountStates.finalAccountsState.slice(-1),
		},
	};
};

const generateTestCasesInvalidBlockWithUnvoteForDelegateNotPreviouslyVoted = () => {
	const initialAccountsStateUnvote = [
		{
			address: '11036225455433466506L',
			publicKey:
				'd13a2659f908146f099da29216a18fd7f845b4e1455087b1a4bced79b6fefadf',
			secondPublicKey: null,
			username: null,
			isDelegate: false,
			secondSignature: false,
			balance: 9999899990000000,
			multiMin: 0,
			multiLifetime: 0,
			nameExist: false,
			missedBlocks: 0,
			producedBlocks: 0,
			rank: null,
			fees: 0,
			rewards: 0,
			vote: 0,
			productivity: 0,
		},
		{
			address: '7917418729031818208L',
			publicKey:
				'addb0e15a44b0fdc6ff291be28d8c98f5551d0cd9218d749e30ddb87c6e31ca9',
			secondPublicKey: null,
			username: 'genesis_100',
			isDelegate: true,
			secondSignature: false,
			balance: 0,
			multiMin: 0,
			multiLifetime: 0,
			nameExist: false,
			missedBlocks: 1,
			producedBlocks: 0,
			rank: 70,
			fees: 0,
			rewards: 0,
			vote: '10000000000000000',
			productivity: 0,
		},
		...genesisDelegateAccounts,
	];

	const accountsForUnvote = {
		// Genesis account, initially holding 100M total supply
		genesis: {
			address: '11036225455433466506L',
			publicKey:
				'd13a2659f908146f099da29216a18fd7f845b4e1455087b1a4bced79b6fefadf',
			passphrase:
				'amazing rose void lion bamboo maid electric involve feed way popular actor',
			balance: '10000000000000000',
			encryptedPassphrase:
				'iterations=1&cipherText=efd726ad67973f374caeda0f715571974789b99e70aa961129f295aa8e4c8d0bb39e321402fbcc126e8bf8630e17c13c4743702cd10343777ba17e443b7d444a76560538030e459afb3e&iv=8654394f37d831abdc5181be&salt=bbeee4479ae011704151acb23f0a889d&tag=44a42e50eb8bdc183fe68161856055b1&version=1',
			password: 'elephant tree paris dragon chair galaxy',
		},
		aDelegate: {
			address: '7917418729031818208L',
			publicKey:
				'6fdfafcd8206c179d351baac5dc104a5ff46453e9d7f27f3e28ef38fc93d7799',
			passphrase:
				'honey lady pepper arch cluster uncover empty toss usual correct boil clay',
			balance: '0',
			delegateName: 'genesis_100',
		},
		votingAccount: {
			passphrase:
				'blame address tube insect cost knock major level regret bring april stick',
			privateKey:
				'b92e223981770c716ee54192a0ad028639d28d41221b72e455447bc4767aeb94caff2242b740a733daa3f3f96fc1592303b60c1704a8ac626e2704da039f41ee',
			publicKey:
				'caff2242b740a733daa3f3f96fc1592303b60c1704a8ac626e2704da039f41ee',
			address: '2222471382442610527L',
			balance: '0',
		},
	};

	const chainStateBuilder = new ChainStateBuilder(
		genesisBlock,
		initialAccountsStateUnvote,
		accountsForUnvote,
	);

	// Give balance from genesis account to delegates just for having account states to compare against
	chainStateBuilder
		.transfer('10')
		.from('11036225455433466506L')
		.to('7917418729031818208L');

	// Fund account that will issue votes
	chainStateBuilder
		.transfer('10')
		.from('11036225455433466506L')
		.to('2222471382442610527L');

	// Forge the block so as to have all delegates in the store
	chainStateBuilder.forge();
	// Vote for an account is not a delegate
	chainStateBuilder
		.castVotesFrom('2222471382442610527L')
		.voteDelegates([])
		.unvoteDelegates([
			'addb0e15a44b0fdc6ff291be28d8c98f5551d0cd9218d749e30ddb87c6e31ca9',
		]);

	chainStateBuilder.forgeInvalidInputBlock();

	const chainAndAccountStates = chainStateBuilder.getScenario();

	return {
		initialState: {
			// Given the library chainStateBuilder saves all mutations we use slice here to pick the first accounts state
			chain: chainAndAccountStates.chain,
			accounts: chainAndAccountStates.initialAccountsState,
		},
		input: chainAndAccountStates.inputBlock,
		output: {
			chain: chainAndAccountStates.chain,
			// Given the library chainStateBuilder saves all mutations we use slice here to pick the last account state
			accounts: chainAndAccountStates.finalAccountsState.slice(-1),
		},
	};
};

const validBlockWithVoteTxSuite = () => ({
	title: 'Valid block processing',
	summary: 'A valid block with votes transactions',
	config: 'mainnet',
	runner: 'block_processing_votes',
	handler: 'valid_block_processing_vote_all_delegates',
	testCases: generateTestCasesValidBlockVotesTx(),
});

const invalidBlockWithTooManyVotesTxSuite = () => ({
	title: 'Invalid block processing',
	summary: 'An invalid block with a vote transaction that exceeds max votes',
	config: 'mainnet',
	runner: 'block_processing_votes',
	handler: 'invalid_block_processing_vote_all_delegates_in_one_transaction',
	testCases: generateTestCasesInvalidBlockTooManyVotesTx(),
});

const invalidBlockWithVotesForNoDelegateTxSuite = () => ({
	title: 'Invalid block processing',
	summary: 'An invalid block with a vote transaction that exceeds max votes',
	config: 'mainnet',
	runner: 'block_processing_votes',
	handler: 'invalid_block_processing_vote_no_delegate',
	testCases: generateTestCasesInvalidBlockVoteNoDelegateTx(),
});

const invalidBlockWithVoteForVotedDelegateSuite = () => ({
	title: 'Invalid block processing',
	summary: 'An invalid block with a vote transaction that exceeds max votes',
	config: 'mainnet',
	runner: 'block_processing_votes',
	handler: 'invalid_block_processing_vote_already_voted_delegate',
	testCases: generateTestCasesInvalidBlockVoteAlreadyVotedDelegateTx(),
});

const invalidBlockWithUnvoteForDelegateNotPreviouslyVoted = () => ({
	title: 'Invalid block processing',
	summary: 'An invalid block with a vote transaction that exceeds max votes',
	config: 'mainnet',
	runner: 'block_processing_votes',
	handler: 'invalid_block_processing_unvote_not_voted_delegate',
	testCases: generateTestCasesInvalidBlockWithUnvoteForDelegateNotPreviouslyVoted(),
});

module.exports = BaseGenerator.runGenerator('block_processing_transfers', [
	validBlockWithVoteTxSuite,
	invalidBlockWithTooManyVotesTxSuite,
	invalidBlockWithVotesForNoDelegateTxSuite,
	invalidBlockWithVoteForVotedDelegateSuite,
	invalidBlockWithUnvoteForDelegateNotPreviouslyVoted,
]);
