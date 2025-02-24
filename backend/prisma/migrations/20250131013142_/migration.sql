/*
  Warnings:

  - You are about to drop the column `total_amount` on the `expense_items` table. All the data in the column will be lost.
  - Added the required column `totalAmount` to the `expense_items` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "expense_items" DROP COLUMN "total_amount",
ADD COLUMN     "totalAmount" DECIMAL(12,2) NOT NULL;
