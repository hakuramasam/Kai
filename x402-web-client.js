/**
 * Kai-AI x402 Web Client - React Implementation
 * Complete working example for browser-based x402 payments
 */

import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';

const KAI_AI_WALLET = "0xb601F79bE23D114867A79C384a3f07111F59C874";
const USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const KAI_CONTRACT = "0x86aF9cB35a613992Ea552E0bA7419F1dAdA3084C";
const BASE_CHAIN_ID = 8453;

const X402WebClient = () => {
  const [walletConnected, setWalletConnected] = useState(false);
  const [userAddress, setUserAddress] = useState('');
  const [tools, setTools] = useState([]);
  const [selectedTool, setSelectedTool] = useState(null);
  const [paymentPayload, setPaymentPayload] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Connect wallet
  const connectWallet = async () => {
    try {
      if (!window.ethereum) {
        throw new Error('Please install MetaMask or Coinbase Wallet');
      }

      const provider = new ethers.providers.Web3Provider(window.ethereum);
      await provider.send('eth_requestAccounts', []);
      const signer = provider.getSigner();
      const address = await signer.getAddress();

      setUserAddress(address);
      setWalletConnected(true);
      return { provider, signer };
    } catch (err) {
      setError(err.message);
      return null;
    }
  };

  // Fetch available tools
  const fetchTools = async () => {
    try {
      const response = await fetch('https://kai-ai.val.run/api/tools');
      const data = await response.json();
      setTools(data.tools);
    } catch (err) {
      setError('Failed to fetch tools: ' + err.message);
    }
  };

  // Create x402 payment payload
  const createX402Payment = async (tool, useKai = false) => {
    try {
      const { signer } = await connectWallet();
      if (!signer) return;

      const tokenContract = useKai ? KAI_CONTRACT : USDC_CONTRACT;
      const decimals = useKai ? 18 : 6;
      const amount = ethers.utils.parseUnits(tool.price_usd.toString(), decimals);

      const authorization = {
        from: userAddress,
        to: KAI_AI_WALLET,
        token: tokenContract,
        amount: amount.toString(),
        nonce: Date.now().toString(),
        deadline: Math.floor(Date.now() / 1000) + 3600,
        chainId: BASE_CHAIN_ID
      };

      const signature = await signer.signMessage(JSON.stringify(authorization));

      const payload = {
        payment: {
          authorization: {
            value: authorization,
            signature: signature
          },
          payer: userAddress,
          payee: KAI_AI_WALLET,
          asset: tokenContract,
          amount: amount.toString(),
          network: `eip155:${BASE_CHAIN_ID}`,
          resource: tool.endpoint
        }
      };

      return btoa(JSON.stringify(payload));
    } catch (err) {
      setError('Payment creation failed: ' + err.message);
      return null;
    }
  };

  // Call tool with payment
  const callTool = async () => {
    if (!selectedTool || !paymentPayload) return;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`https://kai-ai.val.run${selectedTool.endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-PAYMENT': paymentPayload
        },
        body: JSON.stringify(selectedTool.input_schema ? JSON.parse(selectedTool.input_schema) : {})
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Tool call failed');
      }

      const resultData = await response.json();
      setResult(resultData);
    } catch (err) {
      setError('Tool execution failed: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  // Generate payment when tool is selected
  useEffect(() => {
    if (selectedTool && walletConnected) {
      const generatePayment = async () => {
        const payload = await createX402Payment(selectedTool);
        if (payload) setPaymentPayload(payload);
      };
      generatePayment();
    }
  }, [selectedTool, walletConnected]);

  return (
    <div className="x402-client">
      <h1>Kai-AI x402 Web Client</h1>

      {!walletConnected ? (
        <button onClick={connectWallet} className="connect-btn">
          Connect Wallet
        </button>
      ) : (
        <div className="wallet-info">
          <p>Connected: {userAddress.slice(0, 6)}...{userAddress.slice(-4)}</p>
        </div>
      )}

      <div className="tools-section">
        <h2>Available Tools</h2>
        <button onClick={fetchTools}>Refresh Tools</button>

        {error && <div className="error">{error}</div>}

        <div className="tools-list">
          {tools.map(tool => (
            <div key={tool.name} className="tool-card">
              <h3>{tool.name.replace(/_/g, ' ')}</h3>
              <p>{tool.description}</p>
              <p>Price: ${tool.price_usd} USDC</p>
              <button 
                onClick={() => setSelectedTool(tool)}
                disabled={!walletConnected}
              >
                Select
              </button>
            </div>
          ))}
        </div>

        {selectedTool && (
          <div className="payment-section">
            <h2>Payment for {selectedTool.name}</h2>
            <p>Price: ${selectedTool.price_usd} USDC</p>
            <p>Endpoint: {selectedTool.endpoint}</p>

            {paymentPayload ? (
              <div>
                <p>✅ Payment payload generated</p>
                <button 
                  onClick={callTool}
                  disabled={loading}
                >
                  {loading ? 'Processing...' : 'Call Tool'}
                </button>
              </div>
            ) : (
              <p>Generating payment...</p>
            )}

            {result && (
              <div className="result">
                <h3>Result</h3>
                <pre>{JSON.stringify(result, null, 2)}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default X402WebClient;