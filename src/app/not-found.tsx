import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
      <p className="mt-2 text-sm text-neutral-600">
        The page you are looking for does not exist or has moved.
      </p>
      <Link
        href="/"
        className="mx-auto mt-6 rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm hover:bg-neutral-50"
      >
        Back to home
      </Link>
    </main>
  );
}
