"use client";

import { motion } from "framer-motion";
import Balancer from "react-wrap-balancer";
import { Images, Upload, Sparkles, ShieldCheck, Zap, Lock, ArrowRight } from "lucide-react";
import { nFormatter } from "@/lib/utils";
import PhotoBooth from "@/components/home/photo-booth";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { UploadDialog, useUploadDialog } from "@/components/home/upload-dialog";
import { FAQ } from "@/components/home/faq";
import { useUserDataStore } from "@/components/layout/navbar";
import { useSignInDialog } from "@/components/layout/sign-in-dialog";
import { useCheckoutDialog } from "@/components/layout/checkout-dialog";
import { TermsAndPrivacy } from "@/components/layout/terms-and-privacy";

export default function HomePage({ count }: { count: number | null }) {
  const setShowUploadModal = useUploadDialog((s) => s.setOpen);
  const setShowCheckoutModal = useCheckoutDialog((s) => s.setOpen);
  const setShowSignInModal = useSignInDialog((s) => s.setOpen);
  const userData = useUserDataStore((s) => s.userData);

  const handleUploadClick = () => {
    if (!userData) {
      setShowSignInModal(true);
    } else if (userData.credits < 10) {
      setShowCheckoutModal(true);
    } else {
      setShowUploadModal(true);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center px-4 sm:px-6">
      <UploadDialog />

      {/* Hero Section */}
      <div className="z-10 flex w-full max-w-4xl flex-col items-center pt-2 sm:pt-6 text-center">
        {/* Ambient Badge */}
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-black/[0.08] bg-white/80 px-4 py-1.5 shadow-sm backdrop-blur-md transition-all hover:bg-white">
          <Sparkles className="h-3.5 w-3.5 text-amber-500 animate-pulse" />
          <span className="text-xs font-semibold tracking-wide text-neutral-800">
            Next-Gen AI Age Progression · 100% Free
          </span>
        </div>

        {/* Hero Title */}
        <h1 className="bg-gradient-to-b from-neutral-950 via-neutral-800 to-neutral-500 bg-clip-text font-display text-4xl font-bold tracking-tight text-transparent sm:text-6xl md:text-7xl md:leading-[1.1]">
          <Balancer>See how your face ages across decades</Balancer>
        </h1>

        {/* Hero Subtitle */}
        <p className="mt-5 max-w-2xl text-base text-neutral-600 sm:text-lg md:text-xl font-normal leading-relaxed">
          <Balancer>
            Curious what you will look like in 20, 40, or 60 years? Upload a single portrait and watch neural AI synthesize your aging progression into an animated GIF.
          </Balancer>
        </p>

        {/* Action Buttons */}
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3.5">
          <Button
            size="lg"
            className="group relative h-12 rounded-full bg-neutral-950 px-7 text-sm font-semibold text-white shadow-xl shadow-neutral-950/20 transition-all duration-200 hover:scale-[1.02] hover:bg-neutral-800 active:scale-[0.98]"
            onClick={handleUploadClick}
          >
            <Upload className="mr-2 h-4 w-4 transition-transform group-hover:-translate-y-0.5" />
            <span>Upload Your Photo</span>
            <ArrowRight className="ml-2 h-3.5 w-3.5 opacity-60 transition-transform group-hover:translate-x-0.5" />
          </Button>

          <Link href="/gallery">
            <Button
              variant="outline"
              size="lg"
              className="h-12 rounded-full border-black/10 bg-white/80 px-6 text-sm font-medium text-neutral-800 shadow-sm backdrop-blur-sm transition-all hover:bg-white hover:text-neutral-950"
              onClick={(e) => {
                if (!userData) {
                  e.preventDefault();
                  setShowSignInModal(true);
                }
              }}
            >
              <Images className="mr-2 h-4 w-4 text-neutral-500" />
              <span>My Gallery</span>
            </Button>
          </Link>
        </div>

        {/* Trust Chips */}
        <div className="mt-5 flex flex-wrap items-center justify-center gap-4 text-xs text-neutral-500">
          <span className="flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
            100% Private & Auto-Deleting
          </span>
          <span className="text-neutral-300">•</span>
          <span className="flex items-center gap-1.5">
            <Zap className="h-3.5 w-3.5 text-amber-500" />
            Real Neural Synthesis
          </span>
          <span className="text-neutral-300">•</span>
          <span>
            {count && count > 0
              ? `${nFormatter(count)} transformations generated`
              : "Free Forever"}
          </span>
        </div>

        {/* Interactive Photobooth Preview */}
        <div className="w-full">
          <PhotoBooth
            input={`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/temp/input.jpeg`}
            output={`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/temp/output.gif`}
            className="h-auto w-full max-w-[560px]"
          />
        </div>
      </div>

      {/* Bento Feature Section */}
      <div className="mt-20 w-full max-w-5xl">
        <div className="text-center mb-10">
          <h2 className="font-display text-2xl font-bold tracking-tight text-neutral-900 sm:text-4xl">
            Designed for accuracy and privacy
          </h2>
          <p className="mt-3 text-sm text-neutral-500 sm:text-base">
            Everything you need to visualize your future self in seconds
          </p>
        </div>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          {/* Bento Card 1 */}
          <div className="group relative rounded-3xl border border-black/[0.08] bg-white/70 p-7 shadow-lg shadow-neutral-500/5 backdrop-blur-xl transition-all duration-300 hover:border-black/20 hover:shadow-xl hover:shadow-neutral-500/10">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600 mb-5">
              <Sparkles className="h-5 w-5" />
            </div>
            <h3 className="font-display text-lg font-semibold text-neutral-900">
              Neural Landmark Morphing
            </h3>
            <p className="mt-2 text-sm text-neutral-600 leading-relaxed">
              Analyzes facial contours and projects biological aging patterns—producing realistic wrinkles, hair greying, and structural transformation.
            </p>
          </div>

          {/* Bento Card 2 */}
          <div className="group relative rounded-3xl border border-black/[0.08] bg-white/70 p-7 shadow-lg shadow-neutral-500/5 backdrop-blur-xl transition-all duration-300 hover:border-black/20 hover:shadow-xl hover:shadow-neutral-500/10">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600 mb-5">
              <Lock className="h-5 w-5" />
            </div>
            <h3 className="font-display text-lg font-semibold text-neutral-900">
              Strict Ephemeral Privacy
            </h3>
            <p className="mt-2 text-sm text-neutral-600 leading-relaxed">
              Your uploaded photos and generated GIFs are stored in private encrypted storage and purged automatically after 24 hours. Never used for model training.
            </p>
          </div>

          {/* Bento Card 3 */}
          <div className="group relative rounded-3xl border border-black/[0.08] bg-white/70 p-7 shadow-lg shadow-neutral-500/5 backdrop-blur-xl transition-all duration-300 hover:border-black/20 hover:shadow-xl hover:shadow-neutral-500/10">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-50 text-amber-600 mb-5">
              <Zap className="h-5 w-5" />
            </div>
            <h3 className="font-display text-lg font-semibold text-neutral-900">
              Instant Looping GIF
            </h3>
            <p className="mt-2 text-sm text-neutral-600 leading-relaxed">
              Get an animated GIF showing smooth progression from your current age to senior years. Download with a single click and share with friends.
            </p>
          </div>
        </div>
      </div>

      {/* FAQ */}
      <div className="w-full max-w-3xl mt-16">
        <FAQ />
      </div>

      {/* Footer */}
      <TermsAndPrivacy />
    </div>
  );
}
