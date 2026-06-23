import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React, { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Keyboard,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import {
  type ConversationMessage,
  type GeminiSource,
  askGemini,
  generateImage,
  isImageRequest,
} from "@/lib/gemini";

const API_KEY = process.env["EXPO_PUBLIC_GEMINI_API_KEY"] ?? "";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  sources: GeminiSource[];
  imageBase64?: string | null;
  loading?: boolean;
  error?: boolean;
}

function makeId() {
  return Date.now().toString() + Math.random().toString(36).slice(2, 9);
}

function TypingIndicator({ colors }: { colors: ReturnType<typeof useColors> }) {
  return (
    <View style={[styles.aiBubble, { backgroundColor: colors.aiBubble }]}>
      <ActivityIndicator size="small" color={colors.primary} />
    </View>
  );
}

function SourceList({
  sources,
  colors,
}: {
  sources: GeminiSource[];
  colors: ReturnType<typeof useColors>;
}) {
  if (!sources.length) return null;
  return (
    <View style={styles.sourceContainer}>
      {sources.map((s, i) => (
        <Pressable
          key={s.uri}
          onPress={() => Linking.openURL(s.uri)}
          style={styles.sourceRow}
        >
          <Feather name="link" size={11} color={colors.sourceLink} />
          <Text
            style={[styles.sourceText, { color: colors.sourceLink }]}
            numberOfLines={1}
          >
            {i + 1}. {s.title}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function MessageItem({
  item,
  colors,
}: {
  item: ChatMessage;
  colors: ReturnType<typeof useColors>;
}) {
  const isUser = item.role === "user";

  if (item.loading) {
    return (
      <View style={[styles.row, styles.aiRow]}>
        <TypingIndicator colors={colors} />
      </View>
    );
  }

  return (
    <View style={[styles.row, isUser ? styles.userRow : styles.aiRow]}>
      {!isUser && (
        <View style={[styles.avatar, { backgroundColor: colors.primary }]}>
          <Feather name="cpu" size={14} color="#fff" />
        </View>
      )}
      <View style={{ maxWidth: "80%", gap: 6 }}>
        <View
          style={[
            styles.bubble,
            isUser
              ? [styles.userBubble, { backgroundColor: colors.userBubble }]
              : [styles.aiBubble, { backgroundColor: colors.aiBubble }],
          ]}
        >
          {item.imageBase64 ? (
            <Image
              source={{ uri: `data:image/png;base64,${item.imageBase64}` }}
              style={styles.generatedImage}
              resizeMode="contain"
            />
          ) : null}
          {item.text ? (
            <Text
              style={[
                styles.bubbleText,
                {
                  color: isUser ? colors.userBubbleText : colors.aiBubbleText,
                },
                item.error && { color: "#ef4444" },
              ]}
              selectable
            >
              {item.text}
            </Text>
          ) : null}
        </View>
        {!isUser && item.sources.length > 0 && (
          <SourceList sources={item.sources} colors={colors} />
        )}
      </View>
    </View>
  );
}

export default function ChatScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const inputRef = useRef<TextInput>(null);

  const conversationHistory = useCallback((): ConversationMessage[] => {
    return messages
      .filter((m) => !m.loading && !m.error && m.text)
      .map((m) => ({
        role: m.role === "user" ? "user" : "model",
        parts: [{ text: m.text }],
      }));
  }, [messages]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    if (!API_KEY) {
      const errId = makeId();
      setMessages((prev) => [
        {
          id: errId,
          role: "assistant",
          text: "⚠️ EXPO_PUBLIC_GEMINI_API_KEY belum diset. Tambahkan ke Replit Secrets.",
          sources: [],
          error: true,
        },
        ...prev,
      ]);
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const userMsg: ChatMessage = {
      id: makeId(),
      role: "user",
      text,
      sources: [],
    };
    const loadingId = makeId();
    const loadingMsg: ChatMessage = {
      id: loadingId,
      role: "assistant",
      text: "",
      sources: [],
      loading: true,
    };

    const historySnapshot = conversationHistory();
    setMessages((prev) => [loadingMsg, userMsg, ...prev]);
    setInput("");
    setIsLoading(true);
    inputRef.current?.focus();

    try {
      if (isImageRequest(text)) {
        const { imageBase64, text: caption } = await generateImage(text, API_KEY);
        const replyMsg: ChatMessage = {
          id: loadingId,
          role: "assistant",
          text: caption || `Ini gambarnya untuk: "${text}"`,
          sources: [],
          imageBase64,
        };
        setMessages((prev) =>
          prev.map((m) => (m.id === loadingId ? replyMsg : m))
        );
      } else {
        const { text: reply, sources } = await askGemini(
          text,
          historySnapshot,
          API_KEY
        );
        const replyMsg: ChatMessage = {
          id: loadingId,
          role: "assistant",
          text: reply,
          sources,
        };
        setMessages((prev) =>
          prev.map((m) => (m.id === loadingId ? replyMsg : m))
        );
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Gagal memproses permintaan.";
      const errMsg: ChatMessage = {
        id: loadingId,
        role: "assistant",
        text: `⚠️ ${msg}`,
        sources: [],
        error: true,
      };
      setMessages((prev) =>
        prev.map((m) => (m.id === loadingId ? errMsg : m))
      );
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setIsLoading(false);
    }
  }, [input, isLoading, conversationHistory]);

  const webTopPad = Platform.OS === "web" ? 67 : 0;
  const webBottomPad = Platform.OS === "web" ? 34 : 0;

  return (
    <View
      style={[styles.container, { backgroundColor: colors.background }]}
    >
      {/* Header */}
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + 12 + webTopPad,
            borderBottomColor: colors.border,
            backgroundColor: colors.background,
          },
        ]}
      >
        <View style={[styles.headerIcon, { backgroundColor: colors.primary }]}>
          <Feather name="cpu" size={18} color="#fff" />
        </View>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>
          Gemini AI
        </Text>
        {messages.length > 0 && (
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              setMessages([]);
            }}
            style={styles.clearBtn}
            testID="clear-chat"
          >
            <Feather name="trash-2" size={18} color={colors.mutedForeground} />
          </Pressable>
        )}
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior="padding"
        keyboardVerticalOffset={0}
      >
        {/* Messages */}
        {messages.length === 0 ? (
          <View style={styles.emptyState}>
            <View
              style={[
                styles.emptyIcon,
                { backgroundColor: colors.card, borderColor: colors.border },
              ]}
            >
              <Feather name="message-circle" size={36} color={colors.primary} />
            </View>
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
              Tanya Apa Saja
            </Text>
            <Text
              style={[styles.emptySubtitle, { color: colors.mutedForeground }]}
            >
              Powered by Gemini AI dengan Google Search
            </Text>
            <View style={styles.suggestionRow}>
              {[
                "Harga BTC sekarang?",
                "Buatkan gambar kucing",
                "Jelaskan blockchain",
              ].map((s) => (
                <Pressable
                  key={s}
                  onPress={() => setInput(s)}
                  style={[
                    styles.suggestion,
                    { backgroundColor: colors.card, borderColor: colors.border },
                  ]}
                >
                  <Text
                    style={[
                      styles.suggestionText,
                      { color: colors.foreground },
                    ]}
                  >
                    {s}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : (
          <FlatList
            data={messages}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <MessageItem item={item} colors={colors} />
            )}
            inverted
            contentContainerStyle={styles.listContent}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          />
        )}

        {/* Input bar */}
        <View
          style={[
            styles.inputBar,
            {
              borderTopColor: colors.border,
              backgroundColor: colors.background,
              paddingBottom:
                insets.bottom > 0 ? insets.bottom : 12 + webBottomPad,
            },
          ]}
        >
          <View
            style={[
              styles.inputWrapper,
              {
                backgroundColor: colors.input,
                borderColor: colors.border,
              },
            ]}
          >
            <TextInput
              ref={inputRef}
              style={[styles.textInput, { color: colors.foreground }]}
              placeholder="Tanya apa saja..."
              placeholderTextColor={colors.mutedForeground}
              value={input}
              onChangeText={setInput}
              multiline
              maxLength={2000}
              returnKeyType="send"
              onSubmitEditing={sendMessage}
              blurOnSubmit={false}
              testID="chat-input"
            />
            <Pressable
              onPress={sendMessage}
              disabled={!input.trim() || isLoading}
              style={({ pressed }) => [
                styles.sendBtn,
                {
                  backgroundColor:
                    input.trim() && !isLoading
                      ? colors.primary
                      : colors.muted,
                  opacity: pressed ? 0.7 : 1,
                },
              ]}
              testID="send-btn"
            >
              <Feather
                name="arrow-up"
                size={18}
                color={
                  input.trim() && !isLoading
                    ? "#fff"
                    : colors.mutedForeground
                }
              />
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  headerIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    flex: 1,
  },
  clearBtn: {
    padding: 6,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 16,
  },
  row: {
    flexDirection: "row",
    gap: 8,
    alignItems: "flex-end",
  },
  userRow: {
    justifyContent: "flex-end",
  },
  aiRow: {
    justifyContent: "flex-start",
  },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },
  bubble: {
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
  },
  userBubble: {
    borderBottomRightRadius: 4,
  },
  aiBubble: {
    borderBottomLeftRadius: 4,
  },
  bubbleText: {
    fontSize: 15,
    lineHeight: 22,
    fontFamily: "Inter_400Regular",
  },
  generatedImage: {
    width: 220,
    height: 220,
    borderRadius: 12,
  },
  sourceContainer: {
    gap: 4,
    paddingLeft: 36,
  },
  sourceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  sourceText: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    flex: 1,
  },
  inputBar: {
    paddingTop: 10,
    paddingHorizontal: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  inputWrapper: {
    flexDirection: "row",
    alignItems: "flex-end",
    borderRadius: 24,
    borderWidth: 1,
    paddingLeft: 16,
    paddingRight: 6,
    paddingVertical: 6,
    gap: 8,
  },
  textInput: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    maxHeight: 120,
    lineHeight: 22,
    paddingVertical: 4,
  },
  sendBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 12,
  },
  emptyIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    marginBottom: 4,
  },
  emptyTitle: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    textAlign: "center",
  },
  emptySubtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 20,
  },
  suggestionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    justifyContent: "center",
    marginTop: 8,
  },
  suggestion: {
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
  },
  suggestionText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
});
