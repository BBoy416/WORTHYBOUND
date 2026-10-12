-- Coins and bullion (gold and other precious metals) get their own categories.
ALTER TYPE "AssetCategory" ADD VALUE 'COIN' BEFORE 'COLLECTIBLE_CAR';
ALTER TYPE "AssetCategory" ADD VALUE 'BULLION' BEFORE 'COLLECTIBLE_CAR';
