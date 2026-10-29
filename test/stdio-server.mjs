import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { makeServer } from './servers.mjs';
await makeServer('stdio').connect(new StdioServerTransport());
