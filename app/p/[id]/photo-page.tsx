"use client";

import { DataProps } from "@/lib/types";
import { motion } from "framer-motion";
import { FADE_DOWN_ANIMATION_VARIANTS } from "@/lib/constants";
import PhotoBooth from "@/components/home/photo-booth";
import { createClient } from "@/lib/supabase/client";
import { useState, useEffect, useCallback, useRef } from "react";

export default function PhotoPage({
  id,
  data: fallbackData,
}: {
  id: string;
  data: DataProps;
}) {
  const [data, setData] = useState<DataProps>(fallbackData);
  const activeRef = useRef(true);

  // Authoritative server state fetcher
  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/generations/${id}`, { cache: "no-store" });
      if (res.ok && activeRef.current) {
        const gen = await res.json();
        setData((prev) => ({
          ...prev,
          input: gen.inputUrl || prev.input,
          output: gen.outputUrl,
          portrait: gen.portraitUrl || gen.outputUrl,
          failed: gen.failed,
          expired: gen.expired,
        }));
        return gen;
      }
    } catch (err) {
      console.warn(`[Status Fetch Warning] id=${id}:`, err);
    }
    return null;
  }, [id]);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  // 1. Supabase Realtime Subscription Lifecycle:
  // Strictly managed within useEffect with complete channel cleanup on unmount or id change
  useEffect(() => {
    // If generation has reached terminal state, do not subscribe
    if (data.output || data.failed || data.expired) return;

    const supabase = createClient();
    const channel = supabase.channel(`generation:${id}`);

    channel
      .on("broadcast", { event: "status" }, async () => {
        // Realtime notification is an acceleration signal;
        // always retrieve authoritative SQLite state from server endpoint
        await fetchStatus();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [id, data.output, data.failed, data.expired, fetchStatus]);

  // 2. Bounded Polling Fallback:
  // Guarantees UI convergence if WebSockets disconnect, tab sleeps, or Realtime fails
  useEffect(() => {
    // If generation has reached terminal state, do not poll
    if (data.output || data.failed || data.expired) return;

    let timeoutId: NodeJS.Timeout;
    let attempt = 0;
    const maxAttempts = 60; // Max ~5 minutes

    async function poll() {
      if (!activeRef.current) return;

      const gen = await fetchStatus();
      if (!activeRef.current) return;

      // Immediately stop polling sequence upon reaching terminal state
      if (gen && (gen.outputUrl || gen.failed || gen.expired)) {
        return;
      }

      attempt++;
      if (attempt >= maxAttempts) {
        console.warn(`[Polling Terminated] Max attempts reached for generation ${id}`);
        return;
      }

      // Fast responsive polling: 400ms -> 800ms -> 1200ms -> max 3000ms
      const delay = Math.min(400 + attempt * 400, 3000) + Math.random() * 200;
      if (activeRef.current) {
        timeoutId = setTimeout(poll, delay);
      }
    }

    // First poll triggers immediately (350ms) to display result without artificial waiting
    timeoutId = setTimeout(poll, 350);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [id, data.output, data.failed, data.expired, fetchStatus]);

  return (
    <div className="flex flex-col items-center justify-center px-4">
      <motion.div
        className="z-10 flex w-full max-w-2xl flex-col items-center text-center"
        initial="hidden"
        whileInView="show"
        animate="show"
        viewport={{ once: true }}
        variants={{
          hidden: {},
          show: {
            transition: {
              staggerChildren: 0.15,
            },
          },
        }}
      >
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-black/[0.08] bg-white/80 px-3.5 py-1 shadow-sm backdrop-blur-md">
          <span className="text-xs font-semibold text-neutral-800">
            ✨ Neural Aging Complete
          </span>
        </div>

        <motion.h1
          className="bg-gradient-to-b from-neutral-950 via-neutral-800 to-neutral-500 bg-clip-text font-display text-4xl font-bold tracking-tight text-transparent md:text-6xl"
          variants={FADE_DOWN_ANIMATION_VARIANTS}
        >
          Your Future Self, Visualized
        </motion.h1>

        <p className="mt-3 max-w-md text-sm text-neutral-500 sm:text-base">
          Slide or click tabs below to compare your original photo with the neural aging simulation.
        </p>
        <PhotoBooth
          id={id}
          input={data.input}
          output={data.output}
          portrait={data.portrait}
          failed={data.failed}
          expired={data.expired}
          className="h-[350px] sm:h-[600px] sm:w-[600px]"
        />
      </motion.div>
    </div>
  );
}
