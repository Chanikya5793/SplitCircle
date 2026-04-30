import { getAuth } from 'firebase/auth';

const TOKEN_ENDPOINT = process.env.EXPO_PUBLIC_LIVEKIT_TOKEN_ENDPOINT?.trim() ?? '';

const isLocalDevelopmentHost = (hostname: string): boolean => {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
};

const getValidatedTokenEndpoint = (): URL => {
    if (!TOKEN_ENDPOINT) {
        throw new Error('LiveKit token endpoint is not configured.');
    }

    let endpoint: URL;
    try {
        endpoint = new URL(TOKEN_ENDPOINT);
    } catch {
        throw new Error('LiveKit token endpoint is invalid.');
    }

    const isSecure = endpoint.protocol === 'https:';
    const allowInsecureLocal = __DEV__ && endpoint.protocol === 'http:' && isLocalDevelopmentHost(endpoint.hostname);
    if (!isSecure && !allowInsecureLocal) {
        throw new Error('LiveKit token endpoint must use HTTPS in non-development environments.');
    }

    return endpoint;
};

export interface TokenResult {
    token: string;
    url: string;
}

export const LiveKitService = {
    /**
     * Fetches an access token from backend using Firebase user auth.
     *
     * @param roomName - The unique room id for the call session
     * @param chatId - Chat that owns the call
     * @param participantName - Display name for LiveKit participant
     */
    getToken: async (roomName: string, chatId: string, participantName: string): Promise<TokenResult> => {
        const endpointUrl = getValidatedTokenEndpoint();

        const currentUser = getAuth().currentUser;
        if (!currentUser) {
            throw new Error('User must be authenticated before requesting call token.');
        }

        const idToken = await currentUser.getIdToken();

        const response = await fetch(endpointUrl.toString(), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${idToken}`,
            },
            body: JSON.stringify({
                roomName,
                chatId,
                name: participantName,
            }),
        });

        if (!response.ok) {
            let errorMessage = 'Unable to fetch LiveKit token.';
            try {
                const data = await response.json();
                if (typeof data?.error === 'string' && data.error.trim().length > 0) {
                    errorMessage = data.error.trim();
                }
            } catch {
                // Ignore parse errors and use generic message.
            }
            throw new Error(`LiveKit token request failed (${response.status}): ${errorMessage}`);
        }

        const data = await response.json();
        if (typeof data?.token !== 'string' || typeof data?.url !== 'string') {
            throw new Error('Token endpoint returned an invalid response payload.');
        }

        let parsedLiveKitUrl: URL;
        try {
            parsedLiveKitUrl = new URL(data.url);
        } catch {
            throw new Error('Token endpoint returned an invalid LiveKit URL.');
        }

        const isSecureLiveKitUrl = parsedLiveKitUrl.protocol === 'wss:' || parsedLiveKitUrl.protocol === 'https:';
        const allowInsecureLiveKitUrl = __DEV__ &&
            (parsedLiveKitUrl.protocol === 'ws:' || parsedLiveKitUrl.protocol === 'http:') &&
            isLocalDevelopmentHost(parsedLiveKitUrl.hostname);
        if (!isSecureLiveKitUrl && !allowInsecureLiveKitUrl) {
            throw new Error('Token endpoint returned a non-secure LiveKit URL.');
        }

        if (__DEV__) {
            console.log('[LiveKitService] connecting to', parsedLiveKitUrl.toString(), 'tokenLen:', data.token.length);
        }

        return {
            token: data.token,
            url: parsedLiveKitUrl.toString(),
        };
    }
};
