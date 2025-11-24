import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Message } from './useChat';

type MessageBubbleProps = {
    message: Message;
    isOwnMessage: boolean;
};

export const MessageBubble: React.FC<MessageBubbleProps> = ({ message, isOwnMessage }) => {
    const getStatusIcon = (status: Message['status']) => {
        switch (status) {
            case 'pending':
                return '⏰';
            case 'sent':
                return '✓';
            case 'delivered':
                return '✓✓';
            case 'read':
                return '✓✓';
            default:
                return '';
        }
    };

    const statusColor = message.status === 'read' ? '#4FC3F7' : '#999';

    return (
        <View style={[styles.container, isOwnMessage ? styles.ownMessage : styles.otherMessage]}>
            <Text style={styles.text}>{message.text}</Text>
            <View style={styles.footer}>
                <Text style={styles.timestamp}>
                    {new Date(message.timestamp).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                    })}
                </Text>
                {isOwnMessage && (
                    <Text style={[styles.status, { color: statusColor }]}>
                        {getStatusIcon(message.status)}
                    </Text>
                )}
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        maxWidth: '75%',
        borderRadius: 16,
        padding: 12,
        marginVertical: 4,
        marginHorizontal: 8,
    },
    ownMessage: {
        alignSelf: 'flex-end',
        backgroundColor: '#007AFF',
    },
    otherMessage: {
        alignSelf: 'flex-start',
        backgroundColor: '#E5E5EA',
    },
    text: {
        fontSize: 16,
        color: '#fff',
        marginBottom: 4,
    },
    footer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    timestamp: {
        fontSize: 11,
        color: '#fff',
        opacity: 0.7,
    },
    status: {
        fontSize: 12,
    },
});
