/**
 * Kai-AI x402 Backend Service - Node.js Implementation
 * Complete working example for server-to-server x402 payments
 */

const { ethers } = require('ethers');
const axios = require('axios');

class KaiAIBackendClient {
  constructor(privateKey, options = {}) {
    this.wallet = new ethers.Wallet(privateKey);
    this.provider = options.provider || new ethers.providers.JsonRpcProvider(
      options.rpcUrl || 'https://mainnet.base.org'
    );
    this.signer = this.wallet.connect(this.provider);
    
    // Constants
    this.KAI_AI_WALLET = "0xb601F79bE23D114867A79C384a3f07111F59C874";
    this.USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    this.KAI_CONTRACT = "0x86aF9cB35a613992Ea552E0bA7419F1dAdA3084C";
    this.BASE_CHAIN_ID = 8453;
  }

  /**
   * Fetch available tools from Kai-AI
   */
  async getAvailableTools() {
    try {
      const response = await axios.get('https://kai-ai.val.run/api/tools');
      return response.data.tools;
    } catch (error) {
      throw new Error('Failed to fetch tools: ' + error.message);
    }
  }

  /**
   * Create x402 payment payload
   */
  async createX402Payment(tool, options = {}) {
    const { useKai = false, customAmount } = options;
    
    const tokenContract = useKai ? this.KAI_CONTRACT : this.USDC_CONTRACT;
    const decimals = useKai ? 18 : 6;
    const amount = customAmount || ethers.utils.parseUnits(
      tool.price_usd.toString(), 
      decimals
    );

    const authorization = {
      from: this.wallet.address,
      to: this.KAI_AI_WALLET,
      token: tokenContract,
      amount: amount.toString(),
      nonce: Date.now().toString(),
      deadline: Math.floor(Date.now() / 1000) + 3600,
      chainId: this.BASE_CHAIN_ID
    };

    const signature = await this.signer.signMessage(
      JSON.stringify(authorization)
    );

    const payload = {
      payment: {
        authorization: {
          value: authorization,
          signature: signature
        },
        payer: this.wallet.address,
        payee: this.KAI_AI_WALLET,
        asset: tokenContract,
        amount: amount.toString(),
        network: `eip155:${this.BASE_CHAIN_ID}`,
        resource: tool.endpoint
      }
    };

    return Buffer.from(JSON.stringify(payload)).toString('base64');
  }

  /**
   * Call a Kai-AI tool with x402 payment
   */
  async callTool(toolName, toolArguments = {}, options = {}) {
    try {
      // Get tool info
      const tools = await this.getAvailableTools();
      const tool = tools.find(t => t.name === toolName);
      
      if (!tool) {
        throw new Error(`Tool ${toolName} not found`);
      }

      // Create payment
      const paymentPayload = await this.createX402Payment(tool, options);

      // Call the tool
      const response = await axios.post(
        `https://kai-ai.val.run${tool.endpoint}`,
        toolArguments,
        {
          headers: {
            'Content-Type': 'application/json',
            'X-PAYMENT': paymentPayload
          }
        }
      );

      return response.data;
    } catch (error) {
      if (error.response) {
        throw new Error(`Tool call failed: ${error.response.data.error || error.message}`);
      }
      throw new Error('Tool call failed: ' + error.message);
    }
  }

  /**
   * MCP tools/list call
   */
  async listMCPTools() {
    try {
      const response = await axios.post(
        'https://kai-ai.val.run/mcp',
        {
          jsonrpc: '2.0',
          method: 'tools/list',
          id: 1
        },
        {
          headers: { 'Content-Type': 'application/json' }
        }
      );
      return response.data.result.tools;
    } catch (error) {
      throw new Error('MCP tools/list failed: ' + error.message);
    }
  }

  /**
   * MCP tools/call with x402 payment
   */
  async callMCPTool(toolName, arguments = {}, options = {}) {
    try {
      // Get MCP tools
      const mcpTools = await this.listMCPTools();
      const tool = mcpTools.find(t => t.name === toolName);
      
      if (!tool) {
        throw new Error(`MCP tool ${toolName} not found`);
      }

      // Create payment for MCP call
      const paymentPayload = await this.createX402Payment(
        {
          endpoint: '/mcp',
          price_usd: tool.annotations.x402?.price || 0.01
        },
        options
      );

      // Call via MCP
      const response = await axios.post(
        'https://kai-ai.val.run/mcp',
        {
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: arguments
          },
          id: 1
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-PAYMENT': paymentPayload
          }
        }
      );

      return response.data.result;
    } catch (error) {
      if (error.response && error.response.data.error) {
        throw new Error(`MCP call failed: ${error.response.data.error.message}`);
      }
      throw new Error('MCP call failed: ' + error.message);
    }
  }

  /**
   * Get wallet balance
   */
  async getWalletBalance() {
    return {
      address: this.wallet.address,
      balance: ethers.utils.formatEther(await this.provider.getBalance(this.wallet.address))
    };
  }
}

// Example Usage
(async () => {
  try {
    // Initialize with your private key
    const privateKey = process.env.WALLET_PRIVATE_KEY; // 0x... prefix
    if (!privateKey) {
      console.error('Please set WALLET_PRIVATE_KEY environment variable');
      return;
    }

    const client = new KaiAIBackendClient(privateKey);

    // Example 1: Call ai_chat tool
    console.log('Calling ai_chat tool...');
    const aiResult = await client.callTool('ai_chat', {
      query: 'What is the capital of France?'
    });
    console.log('AI Result:', aiResult);

    // Example 2: Call via MCP
    console.log('Calling via MCP...');
    const mcpResult = await client.callMCPTool('ai_chat', {
      query: 'Hello from MCP!'
    });
    console.log('MCP Result:', mcpResult);

    // Example 3: Get wallet info
    const walletInfo = await client.getWalletBalance();
    console.log('Wallet Info:', walletInfo);

  } catch (error) {
    console.error('Error:', error.message);
  }
})();

module.exports = KaiAIBackendClient;