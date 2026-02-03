import { LiveKitRoom } from '@livekit/react-native';

const TOKEN_ENDPOINT = process.env.EXPO_PUBLIC_LIVEKIT_TOKEN_ENDPOINT || 'https://your-token-server.com/api/token';

export interface TokenResult {
    token: string;
    url: string;
}

export const LiveKitService = {
    /**
     * Fetches an access token from your backend.
     * 
     * @param roomName - The unique name of the room (e.g., specific chat ID)
     * @param participantIdentity - unique ID for the user (e.g., userId)
     * @param participantName - Display name
     */
    getToken: async (roomName: string, participantIdentity: string, participantName: string): Promise<TokenResult> => {
        console.log(`🎫 LiveKitService.getToken called:`);
        console.log(`   - roomName: ${roomName}`);
        console.log(`   - identity: ${participantIdentity}`);
        console.log(`   - name: ${participantName}`);
        console.log(`   - endpoint: ${TOKEN_ENDPOINT}`);

        try {
            if (TOKEN_ENDPOINT.includes('your-token-server')) {
                throw new Error('LiveKit Token Endpoint not configured. Please see SERVER_SETUP.md for Cloud Setup.');
            }

            console.log('🎫 Fetching token from backend...');
            const response = await fetch(`${TOKEN_ENDPOINT}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ roomName, identity: participantIdentity, name: participantName }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`🎫 Token fetch failed: ${response.status} - ${errorText}`);
                throw new Error(`Failed to fetch token: ${response.status}`);
            }

            const data = await response.json();
            console.log(`🎫 Token received successfully!`);
            console.log(`   - Server URL: ${data.url}`);
            console.log(`   - Token length: ${data.token?.length || 0} chars`);

            return {
                token: data.token,
                url: data.url,
            };
        } catch (error) {
            console.error('🎫 Error fetching LiveKit token:', error);
            throw error;
        }
    }
};
