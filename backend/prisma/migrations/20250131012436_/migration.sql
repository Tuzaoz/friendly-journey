/*
  Warnings:

  - Added the required column `total_amount` to the `expense_items` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "expense_items" ADD COLUMN     "total_amount" DECIMAL(12,2) NOT NULL;
