"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./page.module.css";
import { createClient } from "@/lib/supabase/client";
import BrainTensorViewer from "./components/BrainTensorViewer";
import type {
  InputType,
  JobStatusResponse,
  Message,
  UploadInitResponse,
} from "@/types";

type ConversationItem = {
  id: string;
  title: string | null;
  updated_at: string;
};

type UploadInitApiResponse = UploadInitResponse & {
  inputType: InputType;
  uploadToken: string;
};

type JobUi = JobStatusResponse & {
  message_id: string | null;
};

const POLL_INTERVAL_MS = 2500;
const MAX_SYNTHETIC_TEXT_BYTES = 80_000;
const DEFAULT_INTERPRET_MODE = "explain_reaction";

function formatTime(ts: string) {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTitle(conversation: ConversationItem) {
  if (conversation.title && conversation.title.trim().length > 0) {
    return conversation.title;
  }

  return `Conversation ${new Date(conversation.updated_at).toLocaleDateString()}`;
}

function statusLabel(status: string) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function createGuestIdentity() {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2);
  return {
    userId: random,
    email: `guest-${random}@example.com`,
  };
}

function isUuid(value: string | null) {
  return Boolean(value) && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value as string);
}

function normalizeDemoIdentity() {
  const storedUserId = readCookie(DEMO_USER_COOKIE);
  const storedEmail = readCookie(DEMO_EMAIL_COOKIE);

  if (storedUserId && isUuid(storedUserId)) {
    if (!storedEmail) {
      setCookie(DEMO_EMAIL_COOKIE, `guest-${storedUserId.slice(0, 8)}@example.com`);
    }

    return {
      userId: storedUserId,
      email: storedEmail ?? `guest-${storedUserId.slice(0, 8)}@example.com`,
    };
  }

  const guest = createGuestIdentity();
  setCookie(DEMO_USER_COOKIE, guest.userId);
  setCookie(DEMO_EMAIL_COOKIE, guest.email);

  return guest;
}

function readCookie(name: string) {
  if (typeof document === "undefined") {
    return null;
  }

  const match = document.cookie.match(new RegExp(`(?:^|; )${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function setCookie(name: string, value: string) {
  if (typeof document === "undefined") {
    return;
  }

  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=604800; samesite=lax`;
}

function clearCookie(name: string) {
  if (typeof document === "undefined") {
    return;
  }

  document.cookie = `${name}=; path=/; max-age=0; samesite=lax`;
}

const DEMO_USER_COOKIE = "tribe_demo_user";
const DEMO_EMAIL_COOKIE = "tribe_demo_email";

export default function Home() {
  const supabase = useMemo(() => createClient(), []);

  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [currentUserEmail, setCurrentUserEmail] = useState<string | null>(null);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [isAuthSubmitting, setIsAuthSubmitting] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [jobsById, setJobsById] = useState<Record<string, JobUi>>({});
  const [artifactUrls, setArtifactUrls] = useState<Record<string, string>>({});
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [composerText, setComposerText] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const interpretingJobIdsRef = useRef<Set<string>>(new Set());
  const sidebarViewportInitializedRef = useRef(false);

  const jobs = useMemo(() => Object.values(jobsById), [jobsById]);
  const isAuthenticated = Boolean(currentUserEmail);

  const refreshConversations = useCallback(async () => {
    const liveDemoSession = Boolean(readCookie(DEMO_USER_COOKIE));
    if (!currentUserEmail && !liveDemoSession) {
      setConversations([]);
      setActiveConversationId(null);
      setMessages([]);
      setJobsById({});
      return;
    }

    if (liveDemoSession) {
      normalizeDemoIdentity();
    }

    const response = await fetch("/api/conversations", { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Failed to load conversations");
    }

    const payload = (await response.json()) as { conversations: ConversationItem[] };
    const ordered = payload.conversations ?? [];
    setConversations(ordered);
    if (!activeConversationId && ordered.length > 0) {
      setActiveConversationId(ordered[0].id);
    }
  }, [activeConversationId, currentUserEmail]);

  const refreshMessages = useCallback(async (conversationId: string) => {
    const response = await fetch(`/api/conversations/${conversationId}/messages`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Failed to load messages");
    }

    const payload = (await response.json()) as { messages: Message[] };
    setMessages(payload.messages ?? []);
  }, []);

  const refreshJobs = useCallback(
    async (conversationId: string) => {
      const response = await fetch(`/api/conversations/${conversationId}/jobs`, { cache: "no-store" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? "Failed to load jobs");
      }

      const payload = (await response.json()) as {
        jobs: Array<{
          id: string;
          status: JobUi["status"];
          input_type: JobUi["input_type"];
          result_shape: number[] | null;
          n_segments: number | null;
          output_json_path: string | null;
          output_npy_path: string | null;
          output_preview_path: string | null;
          error_message: string | null;
          metadata: unknown;
          updated_at: string;
          message_id: string | null;
        }>;
      };

      const mapped = (payload.jobs ?? []).reduce<Record<string, JobUi>>((acc, job) => {
        const metadata =
          typeof job.metadata === "object" && job.metadata && !Array.isArray(job.metadata)
            ? (job.metadata as Record<string, unknown>)
            : {};

        acc[job.id] = {
          id: job.id,
          status: job.status,
          input_type: job.input_type,
          error: job.error_message,
          updated_at: job.updated_at,
          message_id: job.message_id,
          result: {
            shape: job.result_shape ?? [],
            n_segments: job.n_segments ?? 0,
            output_json_path: job.output_json_path,
            output_npy_path: job.output_npy_path,
            output_preview_path: job.output_preview_path,
            output_mesh_path:
              typeof metadata.output_mesh_path === "string"
                ? (metadata.output_mesh_path as string)
                : null,
            brain_features_ready: Boolean(metadata.brain_features_ready),
            interpretation_ready: Boolean(metadata.interpretation_ready),
            interpretation_message_id:
              typeof metadata.interpretation_message_id === "string"
                ? (metadata.interpretation_message_id as string)
                : null,
          },
        };

        return acc;
      }, {});

      setJobsById(mapped);
    },
    []
  );

  const createConversation = useCallback(async () => {
    const { data: sessionData } = await supabase.auth.getUser();
    if (!sessionData.user && !readCookie(DEMO_USER_COOKIE)) {
      throw new Error("Please sign in to create a conversation.");
    }

    if (!sessionData.user) {
      normalizeDemoIdentity();
    }

    const response = await fetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(payload.error ?? "Failed to create conversation");
    }

    const payload = (await response.json()) as { conversation: ConversationItem };
    const data = payload.conversation;

    await refreshConversations();
    setActiveConversationId(data.id);
    setMessages([]);
    setJobsById({});

    return data.id;
  }, [refreshConversations, supabase]);

  const refreshConversationData = useCallback(
    async (conversationId: string) => {
      await Promise.all([refreshMessages(conversationId), refreshJobs(conversationId)]);
    },
    [refreshJobs, refreshMessages]
  );

  const triggerInterpretation = useCallback(
    async (jobId: string) => {
      if (!activeConversationId || interpretingJobIdsRef.current.has(jobId)) {
        return;
      }

      interpretingJobIdsRef.current.add(jobId);
      try {
        const interpretResponse = await fetch(`/api/jobs/${jobId}/interpret`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: DEFAULT_INTERPRET_MODE,
            temperature: 0.3,
            max_tokens: 900,
            user_instruction: "Keep it concise, evidence-grounded, and practical for business teams.",
          }),
        });

        if (!interpretResponse.ok) {
          const payload = (await interpretResponse.json().catch(() => ({}))) as { error?: string };
          throw new Error(payload.error ?? "Failed to interpret completed job.");
        }

        await refreshConversationData(activeConversationId);
      } catch (error) {
        setErrorNotice(error instanceof Error ? error.message : "Failed to interpret completed job.");
      } finally {
        interpretingJobIdsRef.current.delete(jobId);
      }
    },
    [activeConversationId, refreshConversationData]
  );

  useEffect(() => {
    (async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();

        const demoEmail = readCookie(DEMO_EMAIL_COOKIE);

        setCurrentUserEmail(user?.email ?? demoEmail ?? null);
        if (user?.email || demoEmail) {
          await refreshConversations();
        } else {
          setConversations([]);
          setActiveConversationId(null);
          setMessages([]);
          setJobsById({});
        }
      } catch (error) {
        setErrorNotice(error instanceof Error ? error.message : "Failed to load conversations.");
      } finally {
        setIsBootstrapping(false);
      }
    })();
  }, [refreshConversations, supabase]);

  useEffect(() => {
    const syncSidebarForViewport = () => {
      const isDesktop = window.innerWidth > 1024;
      if (isDesktop) {
        setIsSidebarOpen(true);
      } else if (!sidebarViewportInitializedRef.current) {
        setIsSidebarOpen(false);
      }

      sidebarViewportInitializedRef.current = true;
    };

    syncSidebarForViewport();
    window.addEventListener("resize", syncSidebarForViewport);

    return () => {
      window.removeEventListener("resize", syncSidebarForViewport);
    };
  }, []);

  useEffect(() => {
    if (!activeConversationId) {
      return;
    }

    const timer = setTimeout(() => {
      refreshConversationData(activeConversationId).catch((error) => {
        setErrorNotice(error instanceof Error ? error.message : "Failed to load conversation.");
      });
    }, 0);

    return () => clearTimeout(timer);
  }, [activeConversationId, refreshConversationData]);

  useEffect(() => {
    if (!activeConversationId) {
      return;
    }

    const pendingJobIds = jobs.filter((job) => job.status === "queued" || job.status === "processing").map((job) => job.id);
    if (pendingJobIds.length === 0) {
      return;
    }

    const timer = setInterval(async () => {
      for (const jobId of pendingJobIds) {
        const response = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
        if (!response.ok) {
          continue;
        }

        const payload = (await response.json()) as JobStatusResponse;

        setJobsById((prev) => {
          const existing = prev[jobId];
          return {
            ...prev,
            [jobId]: {
              ...payload,
              message_id: existing?.message_id ?? null,
            },
          };
        });

        const isCompleted = payload.status === "completed";
        const interpretationReady = Boolean(payload.result?.interpretation_ready);
        if (isCompleted && !interpretationReady) {
          void triggerInterpretation(jobId);
        }
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [activeConversationId, jobs, triggerInterpretation]);

  useEffect(() => {
    const completedPendingJobs = jobs.filter(
      (job) => job.status === "completed" && !job.result?.interpretation_ready
    );

    if (completedPendingJobs.length === 0) {
      return;
    }

    const timer = window.setTimeout(() => {
      for (const job of completedPendingJobs) {
        void triggerInterpretation(job.id);
      }
    }, 0);

    return () => window.clearTimeout(timer);
  }, [jobs, triggerInterpretation]);

  useEffect(() => {
    (async () => {
      for (const job of jobs) {
        if (!job.result) {
          continue;
        }

        const paths = [
          job.result.output_preview_path,
          job.result.output_json_path,
          job.result.output_npy_path,
          job.result.output_mesh_path,
        ].filter((path): path is string => Boolean(path));

        for (const path of paths) {
          if (artifactUrls[path]) {
            continue;
          }

          const response = await fetch("/api/artifacts/sign", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path, expiresIn: 3600 }),
          });

          if (!response.ok) {
            continue;
          }

          const payload = (await response.json()) as { signedUrl?: string };
          if (payload.signedUrl) {
            setArtifactUrls((prev) => ({ ...prev, [path]: payload.signedUrl as string }));
          }
        }
      }
    })();
  }, [artifactUrls, jobs]);

  const handlePickedFile = useCallback((file: File | null) => {
    setSelectedFile(file);
  }, []);

  const handleSignIn = useCallback(async () => {
    if (!authEmail.trim() || !authPassword) {
      setErrorNotice("Enter both email and password to sign in.");
      return;
    }

    setIsAuthSubmitting(true);
    setErrorNotice(null);

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: authEmail.trim(),
        password: authPassword,
      });

      if (error || !data.user) {
        throw new Error(error?.message ?? "Unable to sign in.");
      }

      setCurrentUserEmail(data.user.email ?? authEmail.trim());
      setAuthPassword("");
      await refreshConversations();
    } catch (error) {
      setErrorNotice(error instanceof Error ? error.message : "Unable to sign in.");
    } finally {
      setIsAuthSubmitting(false);
    }
  }, [authEmail, authPassword, refreshConversations, supabase.auth]);

  const handleQuickTestAccess = useCallback(async () => {
    setIsAuthSubmitting(true);
    setErrorNotice(null);

    try {
      const { data, error } = await supabase.auth.signInAnonymously();
      if (error || !data.user) {
        const guest = normalizeDemoIdentity();
        setCurrentUserEmail(guest.email);
        await refreshConversations();
        return true;
      }

      clearCookie(DEMO_USER_COOKIE);
      clearCookie(DEMO_EMAIL_COOKIE);
      setCurrentUserEmail(data.user.email ?? "anonymous-user");
      await refreshConversations();
      return true;
    } catch (error) {
      setErrorNotice(error instanceof Error ? error.message : "Unable to create test session.");
      return false;
    } finally {
      setIsAuthSubmitting(false);
    }
  }, [refreshConversations, supabase.auth]);

  const handleSignOut = useCallback(async () => {
    setIsAuthSubmitting(true);
    setErrorNotice(null);

    try {
      const { error } = await supabase.auth.signOut();
      if (error) {
        throw new Error(error.message);
      }

      setCurrentUserEmail(null);
      setConversations([]);
      setActiveConversationId(null);
      setMessages([]);
      setJobsById({});
      setArtifactUrls({});
      clearCookie(DEMO_USER_COOKIE);
      clearCookie(DEMO_EMAIL_COOKIE);
    } catch (error) {
      setErrorNotice(error instanceof Error ? error.message : "Unable to sign out.");
    } finally {
      setIsAuthSubmitting(false);
    }
  }, [supabase.auth]);

  const ensureConversationId = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user && !readCookie(DEMO_USER_COOKIE)) {
      throw new Error("Please sign in before sending messages.");
    }

    if (!user) {
      normalizeDemoIdentity();
    }

    if (activeConversationId) {
      return activeConversationId;
    }

    const createdConversationId = await createConversation();
    if (createdConversationId) {
      return createdConversationId;
    }

    if (!user) {
      throw new Error("Unable to resolve active conversation.");
    }

    const { data, error } = await supabase
      .from("conversations")
      .select("id")
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data?.id) {
      throw new Error("Unable to resolve active conversation.");
    }

    setActiveConversationId(data.id);
    return data.id;
  }, [activeConversationId, createConversation, supabase]);

  const createUploadAsset = useCallback(
    async (conversationId: string) => {
      const fileToUpload =
        selectedFile ??
        new File([composerText.slice(0, MAX_SYNTHETIC_TEXT_BYTES)], "prompt.txt", {
          type: "text/plain",
        });

      const initResponse = await fetch("/api/uploads/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: fileToUpload.name,
          fileType: fileToUpload.type,
          fileSize: fileToUpload.size,
          conversationId,
        }),
      });

      if (!initResponse.ok) {
        const payload = (await initResponse.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? "Failed to initialize upload");
      }

      const initPayload = (await initResponse.json()) as UploadInitApiResponse;
      const { error: uploadError } = await supabase.storage
        .from("input-files")
        .uploadToSignedUrl(initPayload.storagePath, initPayload.uploadToken, fileToUpload, {
          contentType: fileToUpload.type,
        });

      if (uploadError) {
        throw new Error(uploadError.message);
      }

      return {
        inputType: initPayload.inputType,
        inputPath: initPayload.storagePath,
      };
    },
    [composerText, selectedFile, supabase.storage]
  );

  const handleSend = useCallback(async () => {
    if (isSubmitting) {
      return;
    }

    if (!isAuthenticated) {
      const quickAccessReady = await handleQuickTestAccess();
      if (!quickAccessReady) {
        setErrorNotice("Create a quick test session first.");
        return;
      }
    }

    if (!composerText.trim() && !selectedFile) {
      setErrorNotice("Enter a message or attach a file.");
      return;
    }

    setIsSubmitting(true);
    setErrorNotice(null);

    try {
      const conversationId = await ensureConversationId();
      const asset = await createUploadAsset(conversationId);

      const jobResponse = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: conversationId,
          user_text: composerText.trim(),
          input_type: asset.inputType,
          input_path: asset.inputPath,
          client_request_id: crypto.randomUUID(),
            interpret_mode: DEFAULT_INTERPRET_MODE,
        }),
      });

      if (!jobResponse.ok) {
        const payload = (await jobResponse.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? "Failed to create job.");
      }

      setComposerText("");
      setSelectedFile(null);
      await refreshConversationData(conversationId);
      await refreshConversations();
    } catch (error) {
      setErrorNotice(error instanceof Error ? error.message : "Unable to submit request.");
    } finally {
      setIsSubmitting(false);
    }
  }, [
    composerText,
    createUploadAsset,
    isAuthenticated,
    ensureConversationId,
    isSubmitting,
    handleQuickTestAccess,
    refreshConversationData,
    refreshConversations,
    selectedFile,
  ]);

  const onDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files?.[0] ?? null;
    handlePickedFile(file);
  }, [handlePickedFile]);

  const jobsByMessageId = useMemo(() => {
    return jobs.reduce<Record<string, JobUi>>((acc, job) => {
      if (job.message_id) {
        acc[job.message_id] = job;
      }
      return acc;
    }, {});
  }, [jobs]);

  if (isBootstrapping) {
    return (
      <div className={styles.loadingShell}>
        <div className={styles.loadingCard}>Initializing workspace...</div>
      </div>
    );
  }

  return (
    <div className={`${styles.page} ${isSidebarOpen ? styles.pageSidebarOpen : styles.pageSidebarClosed}`}>
      {!isSidebarOpen ? (
        <button
          type="button"
          className={styles.sidebarOpenFab}
          onClick={() => setIsSidebarOpen(true)}
          aria-label="Show sidebar"
          aria-expanded={false}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
      ) : null}

      <button
        type="button"
        className={`${styles.sidebarBackdrop} ${isSidebarOpen ? styles.sidebarBackdropVisible : ""}`}
        onClick={() => setIsSidebarOpen(false)}
        aria-label="Close sidebar"
      />

      <aside className={`${styles.sidebar} ${isSidebarOpen ? styles.sidebarOpen : styles.sidebarClosed}`}>
        <button
          type="button"
          className={styles.sidebarCloseIcon}
          onClick={() => setIsSidebarOpen(false)}
          aria-label="Hide sidebar"
          aria-expanded
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>

        <div className={styles.authPanel}>
          <div className={styles.authHeader}>
            <strong>{isAuthenticated ? "Signed in" : "Sign in"}</strong>
            {isAuthenticated ? <span>{currentUserEmail}</span> : <span>Supabase session required</span>}
          </div>

          {isAuthenticated ? (
            <button className={styles.authButton} onClick={handleSignOut} type="button" disabled={isAuthSubmitting}>
              {isAuthSubmitting ? "Signing out..." : "Sign out"}
            </button>
          ) : (
            <>
              <button className={styles.authButton} onClick={handleQuickTestAccess} type="button" disabled={isAuthSubmitting}>
                {isAuthSubmitting ? "Starting..." : "Quick test access"}
              </button>
              <input
                className={styles.authInput}
                type="email"
                placeholder="Email"
                value={authEmail}
                onChange={(event) => setAuthEmail(event.target.value)}
                autoComplete="email"
              />
              <input
                className={styles.authInput}
                type="password"
                placeholder="Password"
                value={authPassword}
                onChange={(event) => setAuthPassword(event.target.value)}
                autoComplete="current-password"
              />
              <button className={styles.authButton} onClick={handleSignIn} type="button" disabled={isAuthSubmitting}>
                {isAuthSubmitting ? "Signing in..." : "Sign in"}
              </button>
            </>
          )}
        </div>

        <button
          className={styles.newChatButton}
          disabled={!isAuthenticated}
          onClick={() => {
            createConversation().catch((error) => {
              setErrorNotice(error instanceof Error ? error.message : "Failed to create conversation.");
            });
          }}
          type="button"
        >
          New Conversation
        </button>

        <div className={styles.conversationList}>
          {conversations.length === 0 ? (
            <div className={styles.emptyList}>No conversations yet.</div>
          ) : (
            conversations.map((conversation) => (
              <button
                key={conversation.id}
                type="button"
                className={`${styles.conversationItem} ${
                  activeConversationId === conversation.id ? styles.conversationItemActive : ""
                }`}
                onClick={() => {
                  setActiveConversationId(conversation.id);
                  if (window.innerWidth <= 1024) {
                    setIsSidebarOpen(false);
                  }
                }}
              >
                <span>{formatTitle(conversation)}</span>
                <small>{formatTime(conversation.updated_at)}</small>
              </button>
            ))
          )}
        </div>
      </aside>

      <main className={styles.main}>
        <section className={styles.stream}>
          {messages.length === 0 ? (
            <div className={styles.emptyState}>
              <h2>Start with text, image, audio, or video.</h2>
              <p>Attach a file or type your prompt. The UI will upload, queue a GPU job, poll status, then auto-generate interpretation.</p>
            </div>
          ) : (
            messages.map((message) => {
              const linkedJob = jobsByMessageId[message.id];
              return (
                <article
                  key={message.id}
                  className={`${styles.messageRow} ${
                    message.role === "user" ? styles.messageUser : styles.messageAssistant
                  }`}
                >
                  <div className={styles.messageBubble}>
                    <span className={styles.roleLabel}>{message.role.toUpperCase()}</span>
                    <p>{message.content || "(No text content)"}</p>
                    <time>{formatTime(message.created_at)}</time>
                  </div>

                  {linkedJob ? (
                    <div className={styles.resultCard}>
                      <div className={styles.resultHeader}>
                        <strong>Inference Result</strong>
                        <span className={`${styles.statusBadge} ${styles[`status_${linkedJob.status}`] || ""}`}>
                          {statusLabel(linkedJob.status)}
                        </span>
                      </div>

                      {linkedJob.result ? (
                        <div className={styles.resultMeta}>
                          <span>segments: {linkedJob.result.n_segments}</span>
                          <span>shape: [{linkedJob.result.shape.join(", ")}]</span>
                        </div>
                      ) : null}

                      {linkedJob.result?.output_npy_path && artifactUrls[linkedJob.result.output_npy_path] ? (
                        <BrainTensorViewer
                          npyUrl={artifactUrls[linkedJob.result.output_npy_path]}
                          meshUrl={
                            linkedJob.result.output_mesh_path
                              ? (artifactUrls[linkedJob.result.output_mesh_path] ?? null)
                              : null
                          }
                        />
                      ) : null}

                      <div className={styles.resultLinks}>
                        {linkedJob.result?.output_json_path && artifactUrls[linkedJob.result.output_json_path] ? (
                          <a href={artifactUrls[linkedJob.result.output_json_path]} target="_blank" rel="noreferrer">
                            summary.json
                          </a>
                        ) : null}
                        {linkedJob.result?.output_npy_path && artifactUrls[linkedJob.result.output_npy_path] ? (
                          <a href={artifactUrls[linkedJob.result.output_npy_path]} target="_blank" rel="noreferrer">
                            predictions.npy
                          </a>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </article>
              );
            })
          )}
        </section>

        <section
          className={`${styles.composer} ${dragActive ? styles.composerDragActive : ""}`}
          data-disabled={!isAuthenticated}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            setDragActive(false);
          }}
          onDrop={onDrop}
        >
          {selectedFile ? (
            <div className={styles.fileChipWrap}>
              <div className={styles.fileChip}>{selectedFile.name}</div>
              <button
                type="button"
                className={styles.fileChipRemove}
                onClick={() => handlePickedFile(null)}
                disabled={!isAuthenticated}
                aria-label="Remove attached file"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
          ) : null}

          <div className={styles.composerInputRow}>
            <div className={styles.attachmentControls}>
              <input
                ref={fileInputRef}
                type="file"
                className={styles.fileInput}
                onChange={(event) => handlePickedFile(event.target.files?.[0] ?? null)}
                disabled={!isAuthenticated}
              />
              <button
                type="button"
                className={styles.attachIconButton}
                onClick={() => fileInputRef.current?.click()}
                disabled={!isAuthenticated}
                aria-label={selectedFile ? "Replace attached file" : "Attach file"}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M21 12.5l-8.2 8.2a5 5 0 01-7.1-7.1l9.2-9.2a3.5 3.5 0 115 5l-9.5 9.5a2 2 0 11-2.8-2.8l8.8-8.8" />
                </svg>
              </button>
            </div>

            <textarea
              value={composerText}
              onChange={(event) => setComposerText(event.target.value)}
              className={styles.textarea}
              placeholder="Describe the audience goal, messaging context, and what you want the system to evaluate..."
              disabled={!isAuthenticated}
            />
          </div>

          <div className={styles.composerFooter}>
            <p>
              {isAuthenticated
                ? "Drag and drop media into this panel or type-only for a synthetic text asset."
                : "Sign in first to unlock upload, job creation, and interpretation."}
            </p>
            <button onClick={handleSend} type="button" disabled={isSubmitting || !isAuthenticated}>
              {isSubmitting ? "Sending..." : "Send"}
            </button>
          </div>

          {errorNotice ? <p className={styles.errorNotice}>{errorNotice}</p> : null}
        </section>
      </main>
    </div>
  );
}
