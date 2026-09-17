import Link from "next/link";
import { AlertTriangle, ArrowLeft, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export const metadata = {
  title: "Authentication Error | Extrapolate",
  description: "An error occurred during authentication",
};

export default function AuthCodeErrorPage() {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-4 py-12">
      <div className="mx-auto flex w-full max-w-md flex-col items-center justify-center rounded-2xl border border-gray-200 bg-white/80 p-8 shadow-xl backdrop-blur-xl sm:p-10">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-100 text-red-600">
          <AlertTriangle className="h-8 w-8" aria-hidden="true" />
        </div>

        <h1 className="mt-6 text-center font-display text-2xl font-bold tracking-tight text-gray-900 sm:text-3xl">
          Authentication Failed
        </h1>

        <p className="mt-3 text-center text-sm leading-relaxed text-gray-600">
          We were unable to complete your sign-in request. This can happen if the
          authorization session timed out, the request was canceled, or the login
          code was already used.
        </p>

        <div className="mt-8 flex w-full flex-col gap-3">
          <Button asChild className="w-full gap-2 shadow-sm">
            <Link href="/">
              <RefreshCw className="h-4 w-4" />
              Try Signing In Again
            </Link>
          </Button>

          <Button asChild variant="outline" className="w-full gap-2">
            <Link href="/">
              <ArrowLeft className="h-4 w-4" />
              Back to Home
            </Link>
          </Button>
        </div>

        <p className="mt-6 text-center text-xs text-gray-400">
          If this issue persists, please check your network connection or try
          again in a few moments.
        </p>
      </div>
    </div>
  );
}
