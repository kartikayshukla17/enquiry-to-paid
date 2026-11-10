import { redirect } from "next/navigation";

/**
 * The bare /app route has no content of its own — it's the console's default landing view. The
 * (console) route group's layout does the actual session/org check (redirecting to /app/onboarding
 * when the signed-in visitor has no business yet, same as this page used to do directly); this
 * just picks Inbox as where a visitor who already has a business lands.
 */
export default function AppIndexPage() {
  redirect("/app/inbox");
}
