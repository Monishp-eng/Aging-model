"use client";

/* eslint-disable @next/next/no-img-element */
import { FADE_DOWN_ANIMATION_VARIANTS } from "@/lib/constants";
import { motion, AnimatePresence } from "framer-motion";
import { Download, Sparkles, User as UserIcon, Share2, Check, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { LoadingCircle } from "../shared/icons";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  Carousel,
  CarouselApi,
  CarouselContent,
  CarouselItem,
} from "@/components/ui/carousel";
import { Card } from "@/components/ui/card";
import Link from "next/link";

function forceDownload(blobUrl: string, filename: string) {
  const a: any = document.createElement("a");
  a.download = filename;
  a.href = blobUrl;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export default function PhotoBooth({
  id,
  input,
  output,
  failed,
  expired,
  initialState = 1,
  className,
}: {
  id?: string;
  input: string;
  output: string | null;
  failed?: boolean | null;
  expired?: boolean | null;
  initialState?: 0 | 1;
  className?: string;
}) {
  const [api, setApi] = useState<CarouselApi>();
  const [current, setCurrent] = useState(initialState);
  const [downloading, setDownloading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (output || failed || expired) return;
    const interval = setInterval(() => {
      setElapsed((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [output, failed, expired]);

  useEffect(() => {
    if (!api) return;

    setCurrent(api.selectedScrollSnap() as 0 | 1);

    api.on("select", () => {
      setCurrent(api.selectedScrollSnap() as 0 | 1);
    });
  }, [api]);

  const handleShare = () => {
    if (typeof window !== "undefined") {
      navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      toast.success("Link copied to clipboard!");
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDownload = () => {
    if (!output) return;
    setDownloading(true);
    fetch(output, {
      headers: new Headers({
        Origin: location.origin,
      }),
      mode: "cors",
    })
      .then((response) => {
        if (!response.ok) throw new Error("Download response not ok");
        return response.blob();
      })
      .then((blob) => {
        const blobUrl = window.URL.createObjectURL(blob);
        forceDownload(blobUrl, `${id || "extrapolate-aging"}.gif`);
        setDownloading(false);
        toast.success("Aging GIF downloaded!");
      })
      .catch((e) => {
        console.error("Download failed:", e);
        setDownloading(false);
        toast.error("Download failed. Right click image and save as.");
      });
  };

  return (
    <motion.div
      className={cn("mx-auto mt-8 flex flex-col items-center", className)}
      variants={FADE_DOWN_ANIMATION_VARIANTS}
    >
      {/* Outer Glow Card Container */}
      <div className="relative w-full max-w-[560px] rounded-3xl bg-white/80 p-3 shadow-2xl shadow-indigo-500/10 ring-1 ring-black/[0.08] backdrop-blur-2xl transition-all duration-300 sm:p-5">
        {/* Top Control Bar: Segmented Pill & Actions */}
        <div className="mb-4 flex items-center justify-between gap-2 px-1">
          {/* Segmented Switcher */}
          <div className="flex items-center rounded-full bg-neutral-100/90 p-1 ring-1 ring-black/[0.05]">
            <button
              onClick={() => api?.scrollTo(0)}
              className={cn(
                "flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all duration-200",
                current === 0
                  ? "bg-white text-neutral-900 shadow-sm"
                  : "text-neutral-500 hover:text-neutral-900",
              )}
            >
              <UserIcon className="h-3.5 w-3.5" />
              <span>Original</span>
            </button>
            <button
              onClick={() => api?.scrollTo(1)}
              className={cn(
                "flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all duration-200",
                current === 1
                  ? "bg-white text-neutral-900 shadow-sm"
                  : "text-neutral-500 hover:text-neutral-900",
              )}
            >
              <Sparkles className="h-3.5 w-3.5 text-amber-500" />
              <span>Aged Result</span>
            </button>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-2">
            {id && output && (
              <>
                <Button
                  onClick={handleShare}
                  variant="outline"
                  size="sm"
                  className="h-8 rounded-full border-black/10 bg-white/80 px-3 text-xs font-medium text-neutral-700 shadow-none hover:bg-neutral-50 hover:text-neutral-900"
                >
                  {copied ? (
                    <Check className="mr-1 h-3.5 w-3.5 text-emerald-600" />
                  ) : (
                    <Share2 className="mr-1 h-3.5 w-3.5" />
                  )}
                  <span>{copied ? "Copied" : "Share"}</span>
                </Button>

                <Button
                  onClick={handleDownload}
                  size="sm"
                  className="h-8 rounded-full bg-neutral-900 px-3.5 text-xs font-medium text-white shadow-md shadow-neutral-900/10 hover:bg-neutral-800"
                >
                  {downloading ? (
                    <LoadingCircle />
                  ) : (
                    <>
                      <Download className="mr-1 h-3.5 w-3.5" />
                      <span>Save GIF</span>
                    </>
                  )}
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Carousel Frame */}
        <Carousel
          setApi={setApi}
          opts={{
            startIndex: initialState,
          }}
          className="relative overflow-hidden rounded-2xl ring-1 ring-black/[0.06]"
        >
          <CarouselContent>
            {/* Slide 0: Input Image */}
            <CarouselItem>
              <Card className="flex aspect-square w-full items-center justify-center overflow-hidden border-0 bg-neutral-950/5">
                {expired ? (
                  <div className="flex flex-col items-center justify-center p-8 text-center">
                    <p className="text-sm font-semibold text-neutral-800">
                      Original Photo Expired
                    </p>
                    <p className="mt-2 text-xs text-neutral-500">
                      Permanently purged after 24 hours under our privacy policy.
                    </p>
                  </div>
                ) : (
                  <img
                    alt="Original uploaded portrait"
                    src={input || ""}
                    className="h-full w-full object-cover"
                  />
                )}
              </Card>
            </CarouselItem>

            {/* Slide 1: Output Image */}
            <CarouselItem>
              <Card className="flex aspect-square w-full items-center justify-center overflow-hidden border-0 bg-neutral-950/5">
                {failed ? (
                  <div className="flex flex-col items-center justify-center p-8 text-center">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-50 text-red-500 mb-3">
                      ⚠️
                    </div>
                    <p className="text-sm font-semibold text-neutral-800">
                      Face Detection Notice
                    </p>
                    <p className="mt-1 text-xs text-neutral-500 max-w-xs">
                      Could not clearly align facial landmarks. Please try a clear, front-facing portrait!
                    </p>
                    <p className="mt-3 text-xs font-medium text-emerald-600">
                      10 credits returned to your account
                    </p>
                  </div>
                ) : expired ? (
                  <div className="flex flex-col items-center justify-center p-8 text-center">
                    <p className="text-sm font-semibold text-neutral-800">
                      Aging Result Expired
                    </p>
                    <p className="mt-2 text-xs text-neutral-500">
                      Automatically removed after 24 hours under our privacy retention policy.
                    </p>
                  </div>
                ) : !output ? (
                  /* Loading State */
                  <div className="flex flex-col items-center justify-center p-8 text-center">
                    <div className="relative mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-tr from-indigo-500/10 via-purple-500/10 to-amber-500/10 ring-1 ring-black/5">
                      <LoadingCircle />
                    </div>
                    <div className="space-y-2">
                      <p className="text-sm font-semibold text-neutral-900">
                        {elapsed < 6
                          ? "Detecting facial landmarks..."
                          : elapsed < 16
                          ? "Applying neural aging weights..."
                          : elapsed < 30
                          ? "Synthesizing decades progression..."
                          : "Compiling animated aging GIF..."}
                      </p>
                      <p className="text-xs text-neutral-500">
                        {elapsed}s elapsed · Running free AI pipeline
                      </p>

                      <div className="mx-auto mt-4 h-1.5 w-52 overflow-hidden rounded-full bg-neutral-200/70">
                        <div
                          className="h-full bg-gradient-to-r from-indigo-500 via-purple-500 to-amber-500 transition-all duration-1000 ease-out"
                          style={{
                            width: `${Math.min(95, Math.floor((elapsed / 35) * 100))}%`,
                          }}
                        />
                      </div>
                    </div>
                  </div>
                ) : (
                  <img
                    alt="AI aging progression"
                    src={output || ""}
                    className="h-full w-full object-cover"
                  />
                )}
              </Card>
            </CarouselItem>
          </CarouselContent>
        </Carousel>

        {/* Bottom Helper / Prompt */}
        <div className="mt-3 flex items-center justify-between px-1 text-[11px] text-neutral-400">
          <span>Click tabs or swipe to compare</span>
          <span className="flex items-center gap-1 text-neutral-500">
            🔒 Auto-deletes in 24h
          </span>
        </div>
      </div>

      {/* Sub-actions for Finished Result */}
      {id && output && (
        <div className="mt-5 flex items-center gap-3">
          <Link href="/">
            <Button
              variant="outline"
              size="sm"
              className="rounded-full border-black/10 bg-white/80 px-4 text-xs font-medium text-neutral-700 shadow-sm hover:bg-neutral-100"
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              <span>Try Another Photo</span>
            </Button>
          </Link>
        </div>
      )}
    </motion.div>
  );
}
