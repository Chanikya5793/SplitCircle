# SplitCircle AI Coding Instructions

## Project Overview
SplitCircle is a React Native application built with Expo, TypeScript, and Firebase. It features group expense splitting, chat, and calling capabilities.

## Architecture & Core Technologies
- **Framework**: React Native (Expo SDK 54) with New Architecture enabled.
- **Language**: TypeScript (Strict mode).
- **Backend**: Firebase (Auth, Firestore) for authentication and real-time data.
- **State Management**: React Context API (`src/context/`) for global state (Auth, Chat, Groups).
- **Navigation**: React Navigation 7 (Stack, Bottom Tabs).
- **Styling**: Custom "Glassmorphism" design system using `expo-blur` and `StyleSheet`.

## Directory Structure & Key Paths
- `src/components/`: Reusable UI components. Look for `GlassView.tsx` and `GlassTabBar.tsx` for styling examples.
- `src/context/`: Global state providers. Primary source of truth for app data.
- `src/firebase/`: Firebase configuration and query logic.
- `src/screens/`: Feature-grouped screens (e.g., `auth/`, `chat/`, `groups/`).
- `src/services/`: Business logic decoupled from UI (e.g., `storageService`, `messageQueueService`).
- `src/models/`: TypeScript interfaces defining the data schema.

## Development Conventions

### TypeScript & Imports
- Use **Path Aliases**: Always use `@/` to import from `src/` (e.g., `import { useAuth } from '@/context/AuthContext'`).
- **Strict Typing**: Avoid `any`. Define interfaces in `src/models/` and import them.

### Component Patterns
- **Functional Components**: Use React functional components with Hooks.
- **Custom Hooks**: Encapsulate logic in `src/hooks/` (e.g., `useCallManager`).
- **Styling**:
  - Use `StyleSheet.create` for styles.
  - Leverage `GlassView` for containers requiring the glass effect.
  - Use `colors` and `theme` from `@/constants`.

### Data Flow
1. **Context API**: Use custom hooks like `useAuth()`, `useChat()`, `useGroups()` to access global state.
2. **Firebase**: Direct Firestore interactions often happen within Context providers or specific hooks.
3. **Services**: Use `src/services/` for complex logic like local storage or message queuing, keeping components clean.

### Environment & Configuration
- Configuration is in `app.config.ts`.
- Environment variables are accessed via `process.env.EXPO_PUBLIC_*`.

## Critical Workflows
- **Running the App**: `npm start` or `npx expo start`.
- **Testing**: *Note: No test suite is currently established.* When adding tests, prefer Jest + React Native Testing Library.

## Specific Implementation Details
- **Glassmorphism**: The app relies heavily on `GlassView` for its visual identity. Ensure new UI components align with this aesthetic.
- **Navigation**: Defined in `src/navigation/AppNavigator.tsx` and `stacks.ts`.
