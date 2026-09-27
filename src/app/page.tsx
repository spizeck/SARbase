import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-6 py-16">
      <h1 className="text-3xl font-bold tracking-tight">SARbase</h1>
      <p className="mt-4 text-neutral-600">
        Open-source operations, administration, and recordkeeping for volunteer
        search and rescue organizations.
      </p>
      <p className="mt-4 text-sm text-neutral-600">
        SARbase records facts and helps people stay organized. It does not
        practice search and rescue: qualified SAR personnel remain responsible
        for all operational decisions.
      </p>
      <p className="mt-8 rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600">
        SARbase is under initial development. Basic record administration is
        available; further features are planned.
      </p>
      <p className="mt-4">
        <Link
          href="/admin"
          className="text-sm font-medium text-neutral-900 underline underline-offset-4 hover:text-neutral-600"
        >
          Administration
        </Link>
      </p>
    </main>
  );
}
