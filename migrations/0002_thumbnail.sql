-- The delivered video's thumbnail lives in R2 (see assetKeys.thumb); the row keeps
-- where it is and the frame size it was drawn for.
ALTER TABLE requests ADD COLUMN thumb_key    TEXT;
ALTER TABLE requests ADD COLUMN thumb_width  INTEGER;
ALTER TABLE requests ADD COLUMN thumb_height INTEGER;
