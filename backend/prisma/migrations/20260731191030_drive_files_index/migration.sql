-- CreateTable
CREATE TABLE "drive_files" (
    "relPath" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drive_files_pkey" PRIMARY KEY ("relPath")
);
