-- CreateTable
CREATE TABLE "RateLimitWindow" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "resetAt" BIGINT NOT NULL,

    CONSTRAINT "RateLimitWindow_pkey" PRIMARY KEY ("key")
);
