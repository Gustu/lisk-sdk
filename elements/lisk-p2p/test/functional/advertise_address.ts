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
 *
 */
import { expect } from 'chai';
import { P2P } from '../../src/index';
import {
	createNetwork,
	destroyNetwork,
	POPULATOR_INTERVAL,
	sharedStateConstants,
} from '../utils/network_setup';
import { wait } from '../utils/helpers';
import { constructPeerId } from '../../src/utils';

describe('Advertise Address', () => {
	let p2pNodeList: ReadonlyArray<P2P> = [];

	const p2pConfig = (wsPort: number, advertiseAddress: boolean = true) => ({
		connectTimeout: 100,
		ackTimeout: 200,
		seedPeers: [
			{
				peerId: constructPeerId('127.0.0.1', 5003),
				ipAddress: '127.0.0.1',
				sharedState: {
					wsPort: 5003,
					advertiseAddress: true,
				},
			},
		],
		wsEngine: 'ws',
		populatorInterval: POPULATOR_INTERVAL,
		maxOutboundConnections: 20,
		maxInboundConnections: 100,
		sharedState: {
			...sharedStateConstants,
			wsPort,
			advertiseAddress,
		},
	});

	beforeEach(async () => {
		const customConfig = () => ({
			advertiseAddress: true,
			populatorInterval: POPULATOR_INTERVAL,
		});

		p2pNodeList = await createNetwork({ networkSize: 4, customConfig });
	});

	afterEach(async () => {
		await destroyNetwork(p2pNodeList);
	});

	it('should advertise address in network when enabled', async () => {
		const advertisePeerPort = 5998;
		const p2pNode = new P2P(p2pConfig(advertisePeerPort));
		await p2pNode.start();
		await wait(400);

		for (let p2p of p2pNodeList) {
			const connectedPeers = p2p
				.getConnectedPeers()
				.filter(p => p.sharedState.wsPort === advertisePeerPort);

			expect(connectedPeers[0].sharedState.wsPort).to.be.eql(advertisePeerPort);
		}
		await p2pNode.stop();
	});

	it('should not advertise address in network when disabled', async () => {
		const advertisePeerPort = 5999;
		const p2pNode = new P2P(p2pConfig(5999, false));
		await p2pNode.start();
		await wait(400);

		for (let p2p of p2pNodeList) {
			const connectedPeers = p2p
				.getConnectedPeers()
				.filter(p => p.sharedState.wsPort === advertisePeerPort);
			const disConnectedPeers = p2p
				.getDisconnectedPeers()
				.filter(p => p.sharedState.wsPort === advertisePeerPort);
			expect(connectedPeers).to.be.empty;
			expect(disConnectedPeers).to.be.empty;
		}

		await p2pNode.stop();
	});
});
