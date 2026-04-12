/**
 * Kai-AI x402 CLI Tool
 * Command-line interface for testing and automation
 */

const { ethers } = require('ethers');
const axios = require('axios');
const { Command } = require('commander');
const fs = require('fs');
const path = require('path');

class KaiAICLI {
  constructor() {
    this.config = this.loadConfig();
    this.provider = new ethers.providers.JsonRpcProvider(
      this.config.rpcUrl || 'https://mainnet.base.org'
    );
  }

  loadConfig() {
    const configPath = path.join(__dirname, 'x402-config.json');
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
    return {
      privateKey: process.env.WALLET_PRIVATE_KEY,
      rpcUrl: 'https://mainnet.base.org',
      defaultToken: 'USDC'
    };
  }

  saveConfig(config) {
    const configPath = path.join(__dirname, 'x402-config.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    this.config = config;
  }

  async createX402Payment(tool, amount, useKai = false) {
    if (!this.config.privateKey) {
      throw new Error('Private key not configured. Run: x402 config');
    }

    const wallet = new ethers.Wallet(this.config.privateKey, this.provider);
    const tokenContract = useKai 
      ? '0x86aF9cB35a613992Ea552E0bA7419F1dAdA3084C'
      : '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    
    const decimals = useKai ? 18 : 6;
    const parsedAmount = ethers.utils.parseUnits(amount.toString(), decimals);

    const authorization = {
      from: wallet.address,
      to: '0xb601F79bE23D114867A79C384a3f07111F59C874',
      token: tokenContract,
      amount: parsedAmount.toString(),
      nonce: Date.now().toString(),
      deadline: Math.floor(Date.now() / 1000) + 3600,
      chainId: 8453
    };

    const signature = await wallet.signMessage(JSON.stringify(authorization));

    return Buffer.from(JSON.stringify({
      payment: {
        authorization: { value: authorization, signature },
        payer: wallet.address,
        payee: '0xb601F79bE23D114867A79C384a3f07111F59C874',
        asset: tokenContract,
        amount: parsedAmount.toString(),
        network: 'eip155:8453',
        resource: tool.endpoint
      }
    })).toString('base64');
  }

  async callTool(toolName, arguments = {}, options = {}) {
    try {
      const toolsResponse = await axios.get('https://kai-ai.val.run/api/tools');
      const tool = toolsResponse.data.tools.find(t => t.name === toolName);
      
      if (!tool) {
        throw new Error(`Tool ${toolName} not found`);
      }

      const paymentPayload = await this.createX402Payment(
        tool,
        tool.price_usd,
        options.useKai
      );

      const response = await axios.post(
        `https://kai-ai.val.run${tool.endpoint}`,
        arguments,
        { headers: { 'Content-Type': 'application/json', 'X-PAYMENT': paymentPayload } }
      );

      return response.data;
    } catch (error) {
      console.error('Error:', error.response?.data || error.message);
      throw error;
    }
  }

  async listTools() {
    const response = await axios.get('https://kai-ai.val.run/api/tools');
    return response.data.tools;
  }

  async getWalletBalance() {
    if (!this.config.privateKey) {
      throw new Error('Private key not configured');
    }
    const wallet = new ethers.Wallet(this.config.privateKey, this.provider);
    const balance = await this.provider.getBalance(wallet.address);
    return ethers.utils.formatEther(balance);
  }
}

// CLI Setup
const program = new Command();
const cli = new KaiAICLI();

program
  .name('x402')
  .description('Kai-AI x402 CLI Tool')
  .version('1.0.0');

program.command('config')
  .description('Configure CLI settings')
  .action(async () => {
    const answers = await program.prompt([
      {
        type: 'password',
        name: 'privateKey',
        message: 'Enter your wallet private key (0x...):'
      },
      {
        type: 'input',
        name: 'rpcUrl',
        message: 'Enter RPC URL:',
        default: 'https://mainnet.base.org'
      },
      {
        type: 'list',
        name: 'defaultToken',
        message: 'Default payment token:',
        choices: ['USDC', 'KAI'],
        default: 'USDC'
      }
    ]);
    
    cli.saveConfig(answers);
    console.log('✅ Configuration saved!');
  });

program.command('tools')
  .description('List available tools')
  .action(async () => {
    const tools = await cli.listTools();
    console.log('Available Tools:');
    tools.forEach(tool => {
      console.log(`• ${tool.name.padEnd(20)} $${tool.price_usd} - ${tool.description}`);
    });
  });

program.command('call <tool>')
  .description('Call a tool')
  .option('--kai', 'Use KAI token instead of USDC')
  .option('--args <args>', 'JSON arguments for the tool')
  .action(async (tool, options) => {
    try {
      const args = options.args ? JSON.parse(options.args) : {};
      console.log(`Calling ${tool}...`);
      
      const result = await cli.callTool(tool, args, { useKai: options.kai });
      console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
      console.error('Failed:', error.message);
    }
  });

program.command('balance')
  .description('Check wallet balance')
  .action(async () => {
    try {
      const balance = await cli.getWalletBalance();
      console.log(`Wallet Balance: ${balance} ETH`);
    } catch (error) {
      console.error('Error:', error.message);
    }
  });

program.command('generate-payment <tool> <amount>')
  .description('Generate x402 payment payload')
  .option('--kai', 'Use KAI token')
  .action(async (tool, amount, options) => {
    try {
      const tools = await cli.listTools();
      const toolInfo = tools.find(t => t.name === tool);
      
      if (!toolInfo) {
        console.error(`Tool ${tool} not found`);
        return;
      }

      const payload = await cli.createX402Payment(
        toolInfo,
        parseFloat(amount),
        options.kai
      );
      
      console.log('X-PAYMENT Header:');
      console.log(payload);
      
      // Also save to file
      fs.writeFileSync('payment-header.txt', payload);
      console.log('✅ Saved to payment-header.txt');
    } catch (error) {
      console.error('Error:', error.message);
    }
  });

program.parse(process.argv);

// If no command specified, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
}