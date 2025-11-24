import { MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { StyleSheet, TextInput, TouchableOpacity, View } from 'react-native';

type ChatInputProps = {
    onSend: (text: string) => Promise<void>;
    disabled?: boolean;
};

export const ChatInput: React.FC<ChatInputProps> = ({ onSend, disabled }) => {
    const [text, setText] = useState('');
    const [sending, setSending] = useState(false);

    const handleSend = async () => {
        if (!text.trim() || sending) return;
        setSending(true);
        await onSend(text.trim());
        setText('');
        setSending(false);
    };

    return (
        <View style={styles.container}>
            <TextInput
                style={styles.input}
                value={text}
                onChangeText={setText}
                placeholder="Type a message..."
                placeholderTextColor="#999"
                multiline
                maxLength={1000}
                editable={!disabled && !sending}
            />
            <TouchableOpacity
                style={[styles.sendButton, (!text.trim() || sending) && styles.sendButtonDisabled]}
                onPress={handleSend}
                disabled={!text.trim() || sending || disabled}
            >
                <MaterialCommunityIcons
                    name="send"
                    size={24}
                    color={(!text.trim() || sending) ? '#999' : '#007AFF'}
                />
            </TouchableOpacity>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        paddingHorizontal: 8,
        paddingVertical: 8,
        backgroundColor: '#fff',
        borderTopWidth: 1,
        borderTopColor: '#E5E5EA',
    },
    input: {
        flex: 1,
        minHeight: 40,
        maxHeight: 100,
        backgroundColor: '#F2F2F7',
        borderRadius: 20,
        paddingHorizontal: 16,
        paddingVertical: 10,
        fontSize: 16,
        color: '#000',
    },
    sendButton: {
        marginLeft: 8,
        width: 40,
        height: 40,
        alignItems: 'center',
        justifyContent: 'center',
    },
    sendButtonDisabled: {
        opacity: 0.5,
    },
});
