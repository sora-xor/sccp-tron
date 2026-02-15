import { defineConfig } from 'hardhat/config';

import hardhatEthers from '@nomicfoundation/hardhat-ethers';
import hardhatMocha from '@nomicfoundation/hardhat-mocha';

export default defineConfig({
  plugins: [hardhatEthers, hardhatMocha],
  solidity: {
    version: '0.8.23',
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
});

