import { collection } from 'firebase/firestore';
import { db } from './firebaseConfig';

export const usersCollection = collection(db, 'users');
export const groupsCollection = collection(db, 'groups');
export const chatsCollection = collection(db, 'chats');
export const expensesCollection = collection(db, 'expenses');
export const callsCollection = collection(db, 'calls');

export const chatMessagesCollection = (chatId: string) => collection(db, 'chats', chatId, 'messages');
