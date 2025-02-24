-- AlterTable
ALTER TABLE "expense_items" ADD COLUMN     "subcategory_id" INTEGER;

-- CreateTable
CREATE TABLE "expense_subcategories" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "category_id" INTEGER NOT NULL,

    CONSTRAINT "expense_subcategories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "expense_subcategories_name_category_id_key" ON "expense_subcategories"("name", "category_id");

-- AddForeignKey
ALTER TABLE "expense_subcategories" ADD CONSTRAINT "expense_subcategories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "expense_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_items" ADD CONSTRAINT "expense_items_subcategory_id_fkey" FOREIGN KEY ("subcategory_id") REFERENCES "expense_subcategories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
