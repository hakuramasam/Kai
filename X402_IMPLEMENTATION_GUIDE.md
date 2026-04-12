# Kai-AI x402 Implementation Guide

Complete working implementations for all platforms to integrate with Kai-AI's x402 payment system.

## 📁 Files Created

### 1. Web Frontend (React)
**File**: `x402-web-client.js`
- Complete React component for browser-based x402 payments
- Wallet connection via MetaMask/Coinbase Wallet
- Tool browsing and selection
- Automatic x402 payment payload generation
- Tool execution with payment headers

### 2. Backend Service (Node.js)
**File**: `x402-backend-service.js`
- Class-based backend client
- Private key management
- Both direct API and MCP tool calls
- Automatic x402 payment creation
- Error handling and retries

### 3. Mobile App (React Native)
**File**: `x402-mobile-app.js`
- Complete mobile implementation
- WalletConnect integration
- Touch-friendly UI
- Payment generation and tool execution
- Alert notifications

## 🚀 Quick Start

### Web Frontend
```bash
# Install dependencies
npm install ethers @walletconnect/web3-provider

# Import component
import X402WebClient from './x402-web-client';

# Use in your app
function App() {
  return <X402WebClient />;
}
```

### Backend Service
```bash
# Install dependencies
npm install ethers axios

# Usage
const KaiAIBackendClient = require('./x402-backend-service');

const client = new KaiAIBackendClient('YOUR_PRIVATE_KEY');

// Call a tool
const result = await client.callTool('ai_chat', {
  query: 'Hello from backend!'
});
```

### Mobile App
```bash
# Install dependencies
npm install ethers @walletconnect/modal-react-native expo-secure-store

# Import component
import X402MobileApp from './x402-mobile-app';

# Use in your app
function App() {
  return <X402MobileApp />;
}
```

## 🔐 Security Best Practices

1. **Never hardcode private keys** - Use environment variables
2. **Use WalletConnect for mobile** - Don't store private keys on device
3. **Validate all inputs** - Especially tool arguments
4. **Handle errors gracefully** - Network issues, payment failures
5. **Use HTTPS** - All communications should be encrypted

## 💳 Payment Flow

1. **User selects tool** from available list
2. **System generates x402 payload** with proper authorization
3. **User signs payload** with their wallet
4. **Payload is base64 encoded** and sent in X-PAYMENT header
5. **Kai-AI verifies** with Coinbase facilitator
6. **Tool executes** and returns result

## 📱 Platform Comparison

| Feature | Web | Backend | Mobile |
|---------|-----|---------|--------|
| Wallet Connection | ✅ MetaMask | ❌ Private Key | ✅ WalletConnect |
| Tool Browsing | ✅ UI | ✅ Programmatic | ✅ UI |
| Payment Generation | ✅ Auto | ✅ Auto | ✅ Auto |
| MCP Support | ✅ Full | ✅ Full | ✅ Full |
| Error Handling | ✅ UI | ✅ Logs | ✅ Alerts |

## 🔧 Customization

### Web
- Modify `styles` for different themes
- Add loading indicators
- Implement tool-specific input forms

### Backend
- Add logging (Winston, Pino)
- Implement rate limiting
- Add caching for tool lists

### Mobile
- Customize UI with native components
- Add biometric authentication
- Implement offline mode

## 📚 Dependencies

### Common
- `ethers.js` - For crypto operations and wallet management

### Web
- `react` - UI framework
- `@walletconnect/web3-provider` - Wallet connection

### Backend
- `axios` - HTTP client

### Mobile
- `@walletconnect/modal-react-native` - Wallet connection
- `expo-secure-store` - Secure storage

## 🎯 Next Steps

1. **Set up your wallet** with USDC or KAI on Base Mainnet
2. **Choose your platform** based on your use case
3. **Install dependencies** for your chosen platform
4. **Customize the UI** to match your brand
5. **Test with small amounts** before production use
6. **Deploy and monitor** your implementation

## 🆘 Troubleshooting

**Wallet not connecting?**
- Make sure MetaMask/WalletConnect is installed
- Check network is set to Base Mainnet
- Ensure you have USDC or KAI tokens

**Payment failing?**
- Verify your wallet has sufficient balance
- Check the payment payload format
- Ensure the signature is valid

**Tool not found?**
- Refresh the tool list
- Check the tool name spelling
- Verify the tool is enabled

## 📞 Support

For issues with these implementations:
- Check the Kai-AI documentation
- Review the x402 specification
- Contact the Kai-AI support team

All implementations are production-ready and follow x402 best practices! 🎉