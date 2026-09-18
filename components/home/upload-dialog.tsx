"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { useMediaQuery } from "@/lib/hooks/use-media-query";
import { Button } from "@/components/ui/button";
import { create } from "zustand";
import Image from "next/image";
import Link from "next/link";
import { Separator } from "@/components/ui/separator";
import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoadingDots } from "@/components/shared/icons";
import { UploadCloud, Camera, RefreshCw, AlertCircle, Check, SwitchCamera } from "lucide-react";
import { useFormState, useFormStatus } from "react-dom";
import { upload } from "@/app/actions/upload";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type UploadDialogStore = {
  open: boolean;
  setOpen: (isOpen: boolean) => void;
};

export const useUploadDialog = create<UploadDialogStore>((set) => ({
  open: false,
  setOpen: (open) => set(() => ({ open: open })),
}));

export function UploadDialog() {
  const [open, setOpen] = useUploadDialog((s) => [s.open, s.setOpen]);
  const isDesktop = useMediaQuery("(min-width: 768px)");

  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={setOpen} modal={true}>
        <DialogContent className="gap-0 overflow-hidden p-0 max-w-lg md:rounded-2xl">
          <DialogHeader className="items-center justify-center space-y-2 px-8 pt-6 pb-4">
            <Link href="/">
              <Image
                src="/logo.png"
                alt="Logo"
                className="h-9 w-9 rounded-xl shadow-sm"
                width={36}
                height={36}
              />
            </Link>
            <DialogTitle className="font-display text-xl font-bold tracking-tight text-neutral-900">
              Select or Capture Photo
            </DialogTitle>
          </DialogHeader>

          <Separator />

          {/* Upload and Webcam Form */}
          <UploadForm isOpen={open} />
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerContent className="rounded-t-2xl max-h-[90vh]">
        <DrawerHeader className="flex flex-col items-center justify-center space-y-2 px-4 pt-6 pb-3">
          <Link href="/">
            <Image
              src="/logo.png"
              alt="Logo"
              className="h-9 w-9 rounded-xl shadow-sm"
              width={36}
              height={36}
            />
          </Link>
          <DrawerTitle className="font-display text-xl font-bold tracking-tight text-neutral-900">
            Select or Capture Photo
          </DrawerTitle>
        </DrawerHeader>

        <Separator />

        <div className="overflow-y-auto px-2">
          <UploadForm isOpen={open} />
        </div>

        <DrawerFooter className="bg-muted/50 pt-2 pb-6">
          <DrawerClose asChild>
            <Button variant="outline" className="rounded-full">Cancel</Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

export function UploadForm({ isOpen }: { isOpen: boolean }) {
  const [mode, setMode] = useState<"upload" | "webcam">("upload");
  const [data, setData] = useState<{
    image: string | null;
  }>({
    image: null,
  });

  const [fileSizeTooBig, setFileSizeTooBig] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  // Webcam stream state
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [hasStream, setHasStream] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isCameraStarting, setIsCameraStarting] = useState(false);
  const [flashEffect, setFlashEffect] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");

  // Stop camera tracks cleanly
  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // ignore
        }
      });
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setHasStream(false);
  }, []);

  // Start webcam with multi-stage fallback
  const startCamera = useCallback(async (deviceIdToUse?: string) => {
    setCameraError(null);
    setIsCameraStarting(true);

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // ignore
        }
      });
      streamRef.current = null;
    }

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Webcam access is not supported by your browser");
      }

      const targetDeviceId = deviceIdToUse || selectedDeviceId;
      let mediaStream: MediaStream;

      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
          video: targetDeviceId
            ? { deviceId: { exact: targetDeviceId } }
            : {
                facingMode: "user",
                width: { ideal: 1280 },
                height: { ideal: 720 },
              },
          audio: false,
        });
      } catch (firstErr) {
        console.warn("High-res / user-facing constraints failed, falling back to basic video:", firstErr);
        mediaStream = await navigator.mediaDevices.getUserMedia({
          video: targetDeviceId ? { deviceId: targetDeviceId } : true,
          audio: false,
        });
      }

      streamRef.current = mediaStream;
      setHasStream(true);

      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
        try {
          await videoRef.current.play();
        } catch (playErr) {
          console.warn("Video auto-play warning:", playErr);
        }
      }

      try {
        const allDevices = await navigator.mediaDevices.enumerateDevices();
        const videoInputs = allDevices.filter((d) => d.kind === "videoinput");
        setDevices(videoInputs);
        if (targetDeviceId) {
          setSelectedDeviceId(targetDeviceId);
        } else if (videoInputs.length > 0 && !selectedDeviceId) {
          setSelectedDeviceId(videoInputs[0].deviceId);
        }
      } catch {
        // ignore
      }
    } catch (err: any) {
      console.error("Camera access error:", err);
      let msg = "Could not access webcam. Please check permissions.";
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        msg = "Camera permission denied. Please allow camera access in your browser.";
      } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
        msg = "No webcam device found on your system.";
      } else if (err.name === "NotReadableError" || err.name === "TrackStartError") {
        msg = "Camera is currently busy or in use by another application.";
      }
      setCameraError(msg);
      toast.error(msg);
    } finally {
      setIsCameraStarting(false);
    }
  }, [selectedDeviceId]);

  // Switch camera if multiple cameras exist
  const switchCamera = useCallback(() => {
    if (devices.length < 2) return;
    const currentIndex = devices.findIndex((d) => d.deviceId === selectedDeviceId);
    const nextIndex = (currentIndex + 1) % devices.length;
    const nextDevice = devices[nextIndex];
    setSelectedDeviceId(nextDevice.deviceId);
    startCamera(nextDevice.deviceId);
  }, [devices, selectedDeviceId, startCamera]);

  // Control camera when switching tabs or closing dialog
  useEffect(() => {
    if (isOpen && mode === "webcam" && !data.image) {
      startCamera();
    } else {
      stopCamera();
    }

    return () => {
      stopCamera();
    };
  }, [isOpen, mode, data.image]);

  // Capture frame from webcam onto canvas and populate file input
  const capturePhoto = useCallback(() => {
    if (!videoRef.current) return;

    const video = videoRef.current;
    const canvas = document.createElement("canvas");
    const width = video.videoWidth || 640;
    const height = video.videoHeight || 640;

    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Mirror image for natural selfie feel
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, width, height);

    // Trigger flash visual
    setFlashEffect(true);
    setTimeout(() => setFlashEffect(false), 200);

    canvas.toBlob(
      (blob) => {
        if (!blob) return;

        const capturedFile = new File([blob], `selfie-${Date.now()}.jpg`, {
          type: "image/jpeg",
        });

        // Set input.files via DataTransfer
        if (fileInputRef.current) {
          const dt = new DataTransfer();
          dt.items.add(capturedFile);
          fileInputRef.current.files = dt.files;
        }

        const dataUrl = canvas.toDataURL("image/jpeg", 0.95);
        setData({ image: dataUrl });
        stopCamera();
        toast.success("Selfie captured!");
      },
      "image/jpeg",
      0.95,
    );
  }, [stopCamera]);

  // Retake photo
  const retakePhoto = useCallback(() => {
    setData({ image: null });
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    if (mode === "webcam") {
      startCamera();
    }
  }, [mode, startCamera]);

  // Handle standard file upload
  const onChangePicture = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setFileSizeTooBig(false);
      const file = event.currentTarget.files && event.currentTarget.files[0];
      if (file) {
        if (file.size / 1024 / 1024 > 10) {
          setFileSizeTooBig(true);
        } else {
          const reader = new FileReader();
          reader.onload = (e) => {
            setData((prev) => ({ ...prev, image: e.target?.result as string }));
          };
          reader.readAsDataURL(file);
        }
      }
    },
    [setData],
  );

  const [state, uploadFormAction] = useFormState(upload, {
    message: "",
    status: 0,
  });

  return (
    <form action={uploadFormAction} className="grid gap-5 bg-muted/30 px-5 py-6 md:px-8">
      {/* Mode Switcher: Upload File vs Live Webcam */}
      <div className="flex items-center justify-center">
        <div className="inline-flex rounded-full bg-neutral-200/80 p-1 ring-1 ring-black/[0.05]">
          <button
            type="button"
            onClick={() => {
              setMode("upload");
              if (!data.image) stopCamera();
            }}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-semibold transition-all duration-200",
              mode === "upload"
                ? "bg-white text-neutral-900 shadow-sm"
                : "text-neutral-600 hover:text-neutral-900",
            )}
          >
            <UploadCloud className="h-3.5 w-3.5" />
            <span>Upload File</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("webcam");
              if (!data.image) startCamera();
            }}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-semibold transition-all duration-200",
              mode === "webcam"
                ? "bg-white text-neutral-900 shadow-sm"
                : "text-neutral-600 hover:text-neutral-900",
            )}
          >
            <Camera className="h-3.5 w-3.5 text-indigo-600" />
            <span>Live Webcam</span>
          </button>
        </div>
      </div>

      <div>
        {fileSizeTooBig && (
          <p className="mb-2 text-center text-xs font-medium text-red-500">
            File size too big (max 10MB)
          </p>
        )}

        {/* --- MODE 1: FILE UPLOAD (DRAG & DROP) --- */}
        {mode === "upload" && !data.image && (
          <label
            htmlFor="image-upload"
            className="group relative flex h-72 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-neutral-300 bg-white/80 shadow-sm transition-all hover:border-neutral-400 hover:bg-neutral-50/50"
          >
            <div
              className="absolute z-[5] h-full w-full rounded-2xl"
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragActive(true);
              }}
              onDragEnter={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragActive(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragActive(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragActive(false);
                setFileSizeTooBig(false);
                const file = e.dataTransfer.files && e.dataTransfer.files[0];
                if (file) {
                  if (file.size / 1024 / 1024 > 10) {
                    setFileSizeTooBig(true);
                  } else {
                    if (fileInputRef.current) {
                      fileInputRef.current.files = e.dataTransfer.files;
                    }
                    const reader = new FileReader();
                    reader.onload = (ev) => {
                      setData((prev) => ({
                        ...prev,
                        image: ev.target?.result as string,
                      }));
                    };
                    reader.readAsDataURL(file);
                  }
                }
              }}
            />
            <div
              className={`${
                dragActive ? "border-2 border-primary bg-primary/5" : ""
              } flex h-full w-full flex-col items-center justify-center rounded-2xl px-6 text-center transition-all`}
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-neutral-100 text-neutral-600 mb-3 shadow-inner">
                <UploadCloud className="h-6 w-6" />
              </div>
              <p className="text-sm font-semibold text-neutral-800">
                Drag & drop or click to upload
              </p>
              <p className="mt-1 text-xs text-neutral-500">
                JPEG, PNG, or WebP · High-resolution front portrait
              </p>
            </div>
          </label>
        )}

        {/* --- MODE 2: LIVE WEBCAM CAPTURE --- */}
        {mode === "webcam" && !data.image && (
          <div className="relative flex h-72 flex-col items-center justify-center overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-950 shadow-inner">
            {cameraError ? (
              <div className="flex flex-col items-center justify-center px-6 text-center">
                <AlertCircle className="h-8 w-8 text-red-400 mb-2" />
                <p className="text-xs text-neutral-300 font-medium">{cameraError}</p>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => startCamera()}
                  className="mt-3 rounded-full text-xs"
                >
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  Retry Access
                </Button>
              </div>
            ) : (
              <>
                {/* Live Video View (Mirrored) - Persistent in DOM */}
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  onLoadedMetadata={() => {
                    setIsCameraStarting(false);
                  }}
                  className={cn(
                    "h-full w-full object-cover [transform:scaleX(-1)] transition-opacity duration-300",
                    isCameraStarting || !hasStream ? "opacity-0 pointer-events-none" : "opacity-100"
                  )}
                />

                {/* Loading indicator overlay during warm-up */}
                {(isCameraStarting || !hasStream) && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-neutral-950 text-center z-10">
                    <LoadingDots color="#ffffff" />
                    <p className="mt-3 text-xs font-medium text-neutral-300">Starting camera...</p>
                    <p className="mt-1 text-[11px] text-neutral-500">
                      Please allow camera access in browser popup
                    </p>
                  </div>
                )}

                {/* Face Alignment Oval Guide */}
                {hasStream && !isCameraStarting && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <div className="h-44 w-36 rounded-[50%] border-2 border-dashed border-white/40 shadow-sm" />
                  </div>
                )}

                {/* Flash Effect on Capture */}
                {flashEffect && (
                  <div className="pointer-events-none absolute inset-0 bg-white opacity-80 transition-opacity z-20" />
                )}

                {/* Switch Camera Button (Shown when 2 or more cameras detected) */}
                {devices.length > 1 && hasStream && (
                  <div className="absolute top-3 right-3 z-10">
                    <button
                      type="button"
                      onClick={switchCamera}
                      title="Switch Camera"
                      className="flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1.5 text-[11px] font-semibold text-white backdrop-blur-md transition-all hover:bg-black/80"
                    >
                      <SwitchCamera className="h-3.5 w-3.5" />
                      <span>Switch Camera</span>
                    </button>
                  </div>
                )}

                {/* Shutter Action Button */}
                {hasStream && !isCameraStarting && (
                  <div className="absolute bottom-3 left-0 right-0 flex items-center justify-center gap-2 z-10">
                    <button
                      type="button"
                      onClick={capturePhoto}
                      className="flex items-center gap-2 rounded-full bg-white px-5 py-2 text-xs font-bold text-neutral-900 shadow-xl ring-2 ring-white/50 transition-all duration-150 hover:scale-105 active:scale-95"
                    >
                      <div className="h-3 w-3 rounded-full bg-red-600 animate-pulse" />
                      <span>Snap Photo</span>
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* --- PREVIEW OF SELECTED / CAPTURED PHOTO --- */}
        {data.image && (
          <div className="relative flex h-72 flex-col items-center justify-center overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-950 shadow-md">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={data.image}
              alt="Photo preview"
              className="h-full w-full object-cover"
            />

            {/* Retake / Change Button Overlay */}
            <div className="absolute top-3 right-3">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={retakePhoto}
                className="h-8 rounded-full border border-black/10 bg-white/90 px-3 text-xs font-semibold shadow-md backdrop-blur-md hover:bg-white"
              >
                <RefreshCw className="mr-1.5 h-3.5 w-3.5 text-neutral-600" />
                <span>Change / Retake</span>
              </Button>
            </div>

            <div className="absolute bottom-3 left-3">
              <span className="flex items-center gap-1 rounded-full bg-black/60 px-3 py-1 text-[11px] font-medium text-white backdrop-blur-md">
                <Check className="h-3 w-3 text-emerald-400" />
                Photo ready
              </span>
            </div>
          </div>
        )}

        {/* Hidden File Input for Canonical Form Submission */}
        <input
          ref={fileInputRef}
          id="image-upload"
          name="image"
          type="file"
          accept="image/*"
          className="sr-only"
          onChange={onChangePicture}
        />

        {state?.message && (
          <p className="mt-2 text-center text-xs text-red-500 font-medium">
            {state.message}
          </p>
        )}
      </div>

      {/* Confirm and Submit Button */}
      <UploadButton data={data} />
    </form>
  );
}

export function UploadButton({ data }: { data: { image: string | null } }) {
  const { pending } = useFormStatus();

  const saveDisabled = useMemo(() => {
    return !data.image || pending;
  }, [data.image, pending]);

  return (
    <Button
      type="submit"
      disabled={saveDisabled}
      className="h-11 w-full rounded-full bg-neutral-950 text-sm font-semibold text-white shadow-md shadow-neutral-900/10 hover:bg-neutral-800 disabled:opacity-50"
    >
      {pending ? (
        <LoadingDots color="#ffffff" />
      ) : (
        <span>Synthesize Aging Progression</span>
      )}
    </Button>
  );
}
