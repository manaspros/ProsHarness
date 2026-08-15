import Link from "next/link";
import { Compass } from "lucide-react";

import { Surface } from "@/components/Surface";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";

/**
 * Next.js's built-in not-found route. Overriding the default unstyled 404
 * ("This page could not be found.") so a missing route reads as an
 * intentional, legible, on-brand empty state instead of low-contrast grey
 * text on the app's near-black background.
 */
export default function NotFound() {
  return (
    <div className="mx-auto max-w-2xl py-16">
      <Surface elevation="raised">
        <EmptyState
          icon={<Compass className="h-8 w-8" />}
          title="Page not found"
          description="This page doesn't exist. Head back to Sessions to find what you're looking for."
          action={
            <Button asChild>
              <Link href="/">Back to Sessions</Link>
            </Button>
          }
        />
      </Surface>
    </div>
  );
}
