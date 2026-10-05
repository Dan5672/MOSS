"use client";

import { Button } from "@/components/ui/button";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  // Permission errors carry a readable message; anything else gets a generic one.
  const permission = error.message.startsWith("You don't have permission");
  return (
    <div className="px-frame p-8 text-center">
      <h1 className="text-lg font-semibold">{permission ? "Not allowed" : "Something went wrong"}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{permission ? error.message : "The page couldn't be loaded. Try again, or check the server logs."}</p>
      {!permission && (
        <Button className="mt-4" variant="outline" onClick={reset}>
          Try again
        </Button>
      )}
    </div>
  );
}
