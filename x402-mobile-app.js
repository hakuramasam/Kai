/**
 * Kai-AI x402 Mobile App - React Native Implementation
 * Complete working example for mobile x402 payments
 */

import React, { useState, useEffect } from 'react';
import { View, Text, Button, ScrollView, StyleSheet, Alert } from 'react-native';
import { ethers } from 'ethers';
import * as SecureStore from 'expo-secure-store';
import { WalletConnectModal, useWalletConnectModal } from '@walletconnect/modal-react-native';

const KAI_AI_WALLET = "0xb601F79bE23D114867A79C384a3f07111F59C874";
const USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const KAI_CONTRACT = "0x86aF9cB35a613992Ea552E0bA7419F1dAdA3084C";
const BASE_CHAIN_ID = 8453;

const projectId = 'YOUR_WALLETCONNECT_PROJECT_ID';

// WalletConnect provider
const providerMetadata = {
  name: 'Kai-AI Mobile',
  description: 'Mobile client for Kai-AI x402 payments',
  url: 'https://kai-ai.val.run',
  icons: ['https://kai-ai.val.run/favicon.ico'],
  redirect: {
    native: 'kai-ai://',
    universal: 'https://kai-ai.val.run'
  }
};

export default function X402MobileApp() {
  const { open, isConnected, address, provider } = useWalletConnectModal();
  const [tools, setTools] = useState([]);
  const [selectedTool, setSelectedTool] = useState(null);
  const [paymentPayload, setPaymentPayload] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Connect wallet
  const connectWallet = async () => {
    try {
      if (!isConnected) {
        await open();
      }
    } catch (err) {
      setError('Wallet connection failed: ' + err.message);
    }
  };

  // Fetch tools
  const fetchTools = async () => {
    try {
      const response = await fetch('https://kai-ai.val.run/api/tools');
      const data = await response.json();
      setTools(data.tools);
    } catch (err) {
      setError('Failed to fetch tools: ' + err.message);
    }
  };

  // Create x402 payment
  const createX402Payment = async (tool, useKai = false) => {
    try {
      if (!isConnected || !provider) {
        throw new Error('Wallet not connected');
      }

      const ethersProvider = new ethers.providers.Web3Provider(provider);
      const signer = ethersProvider.getSigner();
      const userAddress = await signer.getAddress();

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

  // Call tool
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
        body: JSON.stringify({
          query: 'Hello from mobile!'
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Tool call failed');
      }

      const resultData = await response.json();
      setResult(resultData);
      Alert.alert('Success', 'Tool executed successfully!');
    } catch (err) {
      setError('Tool execution failed: ' + err.message);
      Alert.alert('Error', err.message);
    } finally {
      setLoading(false);
    }
  };

  // Generate payment when tool is selected
  useEffect(() => {
    if (selectedTool && isConnected) {
      const generatePayment = async () => {
        const payload = await createX402Payment(selectedTool);
        if (payload) setPaymentPayload(payload);
      };
      generatePayment();
    }
  }, [selectedTool, isConnected]);

  return (
    <View style={styles.container}>
      <WalletConnectModal 
        projectId={projectId}
        providerMetadata={providerMetadata}
      />

      <Text style={styles.title}>Kai-AI Mobile Client</Text>

      {!isConnected ? (
        <Button title="Connect Wallet" onPress={connectWallet} />
      ) : (
        <Text style={styles.walletInfo}>Connected: {address.slice(0, 6)}...{address.slice(-4)}</Text>
      )}

      <Button title="Refresh Tools" onPress={fetchTools} disabled={loading} />

      {error && <Text style={styles.error}>{error}</Text>}

      <ScrollView style={styles.toolsList}>
        {tools.map(tool => (
          <View key={tool.name} style={styles.toolCard}>
            <Text style={styles.toolName}>{tool.name.replace(/_/g, ' ')}</Text>
            <Text style={styles.toolDesc}>{tool.description}</Text>
            <Text style={styles.toolPrice}>${tool.price_usd} USDC</Text>
            <Button 
              title="Select" 
              onPress={() => setSelectedTool(tool)}
              disabled={!isConnected}
            />
          </View>
        ))}
      </ScrollView>

      {selectedTool && (
        <View style={styles.paymentSection}>
          <Text style={styles.sectionTitle}>Payment for {selectedTool.name}</Text>
          <Text>Price: ${selectedTool.price_usd} USDC</Text>
          <Text>Endpoint: {selectedTool.endpoint}</Text>

          {paymentPayload ? (
            <View>
              <Text style={styles.success}>✅ Payment payload generated</Text>
              <Button 
                title={loading ? 'Processing...' : 'Call Tool'} 
                onPress={callTool} 
                disabled={loading}
              />
            </View>
          ) : (
            <Text>Generating payment...</Text>
          )}

          {result && (
            <View style={styles.result}>
              <Text style={styles.resultTitle}>Result:</Text>
              <Text>{JSON.stringify(result, null, 2)}</Text>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    backgroundColor: '#f5f5f5'
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 20,
    textAlign: 'center'
  },
  walletInfo: {
    marginVertical: 10,
    textAlign: 'center',
    color: 'green'
  },
  error: {
    color: 'red',
    marginVertical: 10,
    textAlign: 'center'
  },
  success: {
    color: 'green',
    marginVertical: 10
  },
  toolsList: {
    marginVertical: 20
  },
  toolCard: {
    backgroundColor: 'white',
    padding: 15,
    marginBottom: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ddd'
  },
  toolName: {
    fontSize: 18,
    fontWeight: 'bold'
  },
  toolDesc: {
    marginVertical: 5,
    color: '#666'
  },
  toolPrice: {
    fontWeight: 'bold',
    color: 'blue',
    marginBottom: 10
  },
  paymentSection: {
    marginTop: 20,
    padding: 15,
    backgroundColor: 'white',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ddd'
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 10
  },
  result: {
    marginTop: 20,
    padding: 10,
    backgroundColor: '#f0f0f0',
    borderRadius: 5
  },
  resultTitle: {
    fontWeight: 'bold',
    marginBottom: 5
  }
});