import { deployments, ethers } from 'hardhat';
import { evm, wallet } from '@utils';
import { contract, given, then, when } from '@utils/bdd';
import { expect } from 'chai';
import { getNodeUrl } from 'utils/env';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { IERC20, ITransformer } from '@typechained';
import { BigNumber, constants, utils } from 'ethers';
import { abi as IERC20_ABI } from '@openzeppelin/contracts/build/contracts/IERC20.json';
import { DeterministicFactory, DeterministicFactory__factory } from '@mean-finance/deterministic-factory/typechained';
import { snapshot } from '@utils/evm';
import { setTestChainId } from 'utils/deploy';

const CHAIN = { chain: 'ethereum', chainId: 1 };
const BLOCK_NUMBER = 15014793;

const TOKENS = {
  'cvxCRVCRV Vault': {
    address: '0xB78eBb2248bB72380E690246F9631Cf58c07B444',
    whale: '0x58c8087ef758df6f6b3dc045cf135c850a8307b6',
  },
  cvxCRVCRV: {
    address: '0x9d0464996170c6b9e75eed71c68b99ddedf279e8',
    whale: '0x903da6213a5a12b61c821598154efad98c3b20e4',
  },
};

describe('Comprehensive Transformer Test', () => {
  let deployer: SignerWithAddress, signer: SignerWithAddress, recipient: SignerWithAddress;

  before(async () => {
    [deployer, signer, recipient] = await ethers.getSigners();
    await fork({ ...CHAIN, blockNumber: BLOCK_NUMBER });
  });

  transformerComprehensiveTest({
    transformer: 'ERC4626Transformer',
    dependent: 'cvxCRVCRV Vault',
    underlying: ['cvxCRVCRV'],
  });

  function transformerComprehensiveTest({
    transformer: transformerName,
    title,
    dependent: dependentId,
    underlying: underlyingIds,
  }: {
    title?: string;
    transformer: string;
    dependent: keyof typeof TOKENS;
    underlying: (keyof typeof TOKENS)[];
  }) {
    contract(title ?? transformerName, () => {
      const INITIAL_SIGNER_BALANCE = utils.parseEther('1');
      let dependent: IERC20, underlying: IERC20[];
      let transformer: ITransformer;
      let snapshotId: string;
      before(async () => {
        // Deploy transformer
        await deployments.fixture([transformerName], { keepExistingDeployments: true });
        transformer = await ethers.getContract<ITransformer>(transformerName);

        // Sent tokens from whales to signer
        const tokens: IERC20[] = [];
        for (const tokenId of [dependentId, ...underlyingIds]) {
          const token = await ethers.getContractAt<IERC20>(IERC20_ABI, TOKENS[tokenId].address);
          const whale = await wallet.impersonate(TOKENS[tokenId].whale);
          await ethers.provider.send('hardhat_setBalance', [whale._address, '0xffffffffffffffff']);
          await token.connect(whale).transfer(signer.address, INITIAL_SIGNER_BALANCE);
          tokens.push(token);
        }
        [dependent, ...underlying] = tokens;

        // Take snapshot
        snapshotId = await snapshot.take();
      });
      beforeEach(async () => {
        await snapshot.revert(snapshotId);
      });
      describe('getUnderlying', () => {
        when('asked for the underlying tokens', () => {
          then('the correct addresses are returned', async () => {
            const underlyingTokens = await transformer.getUnderlying(dependent.address);
            expect(underlyingTokens.length).to.equal(underlying.length);
            for (const underlyingToken of underlyingTokens) {
              expect(isTokenUnderyling(underlyingToken)).to.be.true;
            }
          });
        });
      });
      describe('calculateTransformToUnderlying', () => {
        const AMOUNT_DEPENDENT = utils.parseEther('1');
        when('calculating the transformation to underlying', () => {
          let returnedUnderlying: ITransformer.UnderlyingAmountStructOutput[];
          given(async () => {
            returnedUnderlying = await transformer.calculateTransformToUnderlying(dependent.address, AMOUNT_DEPENDENT);
          });
          then('all underlying tokens are part of the result', () => {
            expect(returnedUnderlying.length).to.equal(underlying.length);
            for (const { underlying: underlyingToken } of returnedUnderlying) {
              expect(isTokenUnderyling(underlyingToken)).to.be.true;
            }
          });
          then('transforming back to dependent returns the same value', async () => {
            // Note: this test assumes that there is no transform fee
            expect(await transformer.calculateTransformToDependent(dependent.address, returnedUnderlying)).to.equal(AMOUNT_DEPENDENT);
          });
        });
      });
      describe('calculateTransformToDependent', () => {
        const AMOUNT_PER_UNDERLYING = utils.parseEther('1');
        when('calculating the transformation to dependent', () => {
          let returnedDependent: BigNumber;
          given(async () => {
            const input = underlying.map((underlying) => ({ underlying: underlying.address, amount: AMOUNT_PER_UNDERLYING }));
            returnedDependent = await transformer.calculateTransformToDependent(dependent.address, input);
          });
          then('transforming back to underlying returns the same value', async () => {
            // Note: this test assumes that there is no transform fee
            const returnedUnderlying = await transformer.calculateTransformToUnderlying(dependent.address, returnedDependent);
            expect(returnedUnderlying.length).to.equal(underlying.length);
            for (const { underlying: underlyingToken, amount } of returnedUnderlying) {
              expect(isTokenUnderyling(underlyingToken)).to.be.true;
              expect(amount).to.equal(AMOUNT_PER_UNDERLYING);
            }
          });
        });
      });
      describe('transformToUnderlying', () => {
        const AMOUNT_DEPENDENT = utils.parseEther('1');
        when('transforming to underlying', () => {
          let expectedUnderlying: ITransformer.UnderlyingAmountStructOutput[];
          given(async () => {
            await dependent.connect(signer).approve(transformer.address, AMOUNT_DEPENDENT);
            expectedUnderlying = await transformer.calculateTransformToUnderlying(dependent.address, AMOUNT_DEPENDENT);
            await transformer.connect(signer).transformToUnderlying(dependent.address, AMOUNT_DEPENDENT, recipient.address);
          });
          then('allowance is spent', async () => {
            expect(await dependent.allowance(signer.address, transformer.address)).to.equal(0);
          });
          then('dependent tokens are transferred', async () => {
            const balance = await dependent.balanceOf(signer.address);
            expect(balance).to.equal(INITIAL_SIGNER_BALANCE.sub(AMOUNT_DEPENDENT));
          });
          then('underlying tokens are sent to the recipient', async () => {
            for (const { underlying, amount } of expectedUnderlying) {
              const token = await ethers.getContractAt<IERC20>(IERC20_ABI, underlying);
              const recipientBalance = await token.balanceOf(recipient.address);
              expect(recipientBalance).to.equal(amount);
            }
          });
        });
      });
      describe('transformToDependent', () => {
        const AMOUNT_PER_UNDERLYING = utils.parseEther('1');
        when('transforming to dependent', () => {
          let expectedDependent: BigNumber;
          given(async () => {
            const input = underlying.map((token) => ({ underlying: token.address, amount: AMOUNT_PER_UNDERLYING }));
            for (const underlyingToken of underlying) {
              await underlyingToken.connect(signer).approve(transformer.address, AMOUNT_PER_UNDERLYING);
            }
            expectedDependent = await transformer.calculateTransformToDependent(dependent.address, input);
            await transformer.connect(signer).transformToDependent(dependent.address, input, recipient.address);
          });
          then('allowance is spent for all underlying tokens', async () => {
            for (const underlyingToken of underlying) {
              expect(await underlyingToken.allowance(signer.address, transformer.address)).to.equal(0);
            }
          });
          then('underlying tokens are transferred', async () => {
            for (const underlyingToken of underlying) {
              const balance = await underlyingToken.balanceOf(signer.address);
              expect(balance).to.equal(INITIAL_SIGNER_BALANCE.sub(AMOUNT_PER_UNDERLYING));
            }
          });
          then('dependent tokens are sent to the recipient', async () => {
            const recipientBalance = await dependent.balanceOf(recipient.address);
            expect(recipientBalance).to.equal(expectedDependent);
          });
        });
      });
      function isTokenUnderyling(token: string) {
        const underlyingTokens = underlying.map(({ address }) => address.toLowerCase());
        return underlyingTokens.includes(token.toLowerCase());
      }
    });
  }

  const DETERMINISTIC_FACTORY_ADMIN = '0x1a00e1e311009e56e3b0b9ed6f86f5ce128a1c01';
  const DEPLOYER_ROLE = utils.keccak256(utils.toUtf8Bytes('DEPLOYER_ROLE'));
  async function fork({ chain, chainId, blockNumber }: { chain: string; chainId: number; blockNumber?: number }): Promise<void> {
    // Set fork of network
    await evm.reset({
      jsonRpcUrl: getNodeUrl(chain),
      blockNumber,
    });
    setTestChainId(chainId);
    // Give deployer role to our deployer address
    const admin = await wallet.impersonate(DETERMINISTIC_FACTORY_ADMIN);
    await wallet.setBalance({ account: admin._address, balance: constants.MaxUint256 });
    const deterministicFactory = await ethers.getContractAt<DeterministicFactory>(
      DeterministicFactory__factory.abi,
      '0xbb681d77506df5CA21D2214ab3923b4C056aa3e2'
    );
    await deterministicFactory.connect(admin).grantRole(DEPLOYER_ROLE, deployer.address);
  }
});