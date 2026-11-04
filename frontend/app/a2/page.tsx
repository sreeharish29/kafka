
"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import styles from "./a2.module.css";

import {
  getJob,
  lastSentence,
  type VerifyResponse,
} from "../lib/verifyClient";

type A2Result = {
  status?: string;
  intent?: "challenging" | "neutral" | "evaluative";
  confidence?: number;
  warnings?: string[];
};

type PageState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "done";
      sentence: string;
      result: A2Result;
    };

const intentDescriptions: Record<string, string> = {
  challenging:
    "The input is framed to challenge, question, or dispute an existing claim.",
  neutral:
    "The input is presented in a neutral manner without a strong evaluative stance.",
  evaluative:
    "The input expresses an assessment, judgment, or evaluation.",
};

export default function A2Page() {
  const router = useRouter();

  const [pageState, setPageState] = useState<PageState>({
    kind: "loading",
  });

    useEffect(() => {
    const job = getJob();
    if (!job) {
        setPageState({
        kind: "error",
        message: "No previous investigation was found. Please start an investigation from A1.",
        });
        return;
    }

    const unsubscribe = job.subscribe((ev) => {
        if (ev.type === "a2") {
        setPageState({
            kind: "done",
            sentence: job.sentence,
            result: ev.a2,
        });
        } else if (ev.type === "error") {
        setPageState({
            kind: "error",
            message: `[${ev.stage}] ${ev.error}`,
        });
        }
    });

    return unsubscribe;
    }, []);

  const confidence = useMemo(() => {
    if (pageState.kind !== "done") return 0;

    const value = Number(pageState.result.confidence ?? 0);

    if (!Number.isFinite(value)) return 0;

    return Math.min(100, Math.max(0, value * 100));
  }, [pageState]);

  const intent = pageState.kind === "done"
    ? pageState.result.intent ?? "unknown"
    : "";

  const intentLabel =
    intent.charAt(0).toUpperCase() + intent.slice(1);

  function continueToA3() {
    router.push("/a3/files");
  }

  function backToA1() {
    router.push("/a1");
  }

  return (
    <main className={styles.workspace}>
      <div className={styles.ambientGlow} />
      <div className={styles.vignette} />

      <header className={styles.topBar}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>N</span>
          <span>NEWS INTELLIGENCE</span>
        </div>

        <div className={styles.stageIndicator}>
          <span className={styles.stageCompleted}>A1</span>
          <span className={styles.stageLine} />
          <span className={styles.stageActive}>A2</span>
          <span className={styles.stageLine} />
          <span className={styles.stageUpcoming}>A3</span>
        </div>

        <div className={styles.topRight}>
          <span className={styles.stageLabel}>INTENT ANALYSIS</span>
        </div>
      </header>

      <section className={styles.content}>
        <div className={styles.heading}>
          <div className={styles.eyebrow}>
            <span className={styles.eyebrowDot} />
            STAGE 02 / INTENT CLASSIFICATION
          </div>

          <h1>
            Understand the <span>intent.</span>
          </h1>

          <p>
            The submitted input has been analysed to identify its
            communication intent.
          </p>
        </div>

        {pageState.kind === "loading" && (
          <div className={styles.loadingState}>
            <div className={styles.loader} />
            <p>Retrieving intent classification...</p>
            <span>Please wait while we load the A2 result.</span>
          </div>
        )}

        {pageState.kind === "error" && (
          <div className={styles.errorCard}>
            <div className={styles.errorIcon}>!</div>
            <h2>Unable to load A2 result</h2>
            <p>{pageState.message}</p>
            <button
              className={styles.secondaryButton}
              onClick={backToA1}
            >
              ← Back to A1
            </button>
          </div>
        )}

        {pageState.kind === "done" && (
          <>
            <section className={styles.inputCard}>
              <div className={styles.cardHeading}>
                <div>
                  <span className={styles.cardEyebrow}>ORIGINAL INPUT</span>
                  <h2>Submitted statement</h2>
                </div>
                <span className={styles.inputTag}>A1 INPUT</span>
              </div>

              <p className={styles.inputText}>
                {pageState.sentence || "Input text is unavailable."}
              </p>
            </section>

            <section className={styles.resultSection}>
              <div className={styles.resultEyebrow}>
                <span className={styles.resultLine} />
                DETECTED INTENT
                <span className={styles.resultLine} />
              </div>

              <div className={styles.intentCard}>
                <div className={styles.intentOrb}>
                  <div className={styles.orbInner}>
                    <span className={styles.orbLabel}>INTENT</span>
                    <span className={styles.orbCode}>A2</span>
                  </div>
                </div>

                <div className={styles.intentName}>{intentLabel}</div>

                <p className={styles.intentDescription}>
                  {intentDescriptions[intent] ??
                    "The intent classification was returned by the model."}
                </p>

                <div className={styles.confidenceBlock}>
                  <div className={styles.confidenceHeader}>
                    <span>MODEL CONFIDENCE</span>
                    <strong>{confidence.toFixed(1)}%</strong>
                  </div>

                  <div
                    className={styles.confidenceTrack}
                    role="progressbar"
                    aria-label="Intent classification confidence"
                    aria-valuenow={confidence}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div
                      className={styles.confidenceFill}
                      style={{ width: `${confidence}%` }}
                    />
                  </div>

                  <div className={styles.confidenceFooter}>
                    <span>0%</span>
                    <span>100%</span>
                  </div>
                </div>

                <div className={styles.resultMeta}>
                  <span className={styles.successDot} />
                  CLASSIFICATION COMPLETED
                </div>
              </div>
            </section>

            {pageState.result.warnings &&
              pageState.result.warnings.length > 0 && (
                <div className={styles.warningCard}>
                  <strong>Model warnings</strong>
                  {pageState.result.warnings.map((warning, index) => (
                    <p key={index}>{warning}</p>
                  ))}
                </div>
              )}

            <div className={styles.navigation}>
              <button
                className={styles.backButton}
                onClick={backToA1}
              >
                ← Back to A1
              </button>

              <button
                className={styles.nextButton}
                onClick={continueToA3}
              >
                <span>Continue to A3</span>
                <span className={styles.nextArrow}>→</span>
              </button>
            </div>
          </>
        )}
      </section>

      <footer className={styles.footer}>
        <span>REAL-TIME NEWS MISINFORMATION DETECTION</span>
        <span>AI372IA · TEAM 12</span>
      </footer>
    </main>
  );
}
