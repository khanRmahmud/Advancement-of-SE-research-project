
/*
 * Summit LLM Testing Research
 *
 * STEP 22: TypeScript Unit-Test Infrastructure Check
 *
 * Purpose:
 * Verify that TypeScript unit tests compile and can
 * execute the real removePostService() with mocks.
 *
 * This is a manually written infrastructure test.
 * It is NOT part of the baseline or guided experiment.
 *
 * No PostgreSQL connection.
 * No Docker.
 * No GPT API call.
 */

import test from 'node:test';
import assert from 'node:assert/strict';


// ============================================================
// TEST 1: Authorized post deletion
// ============================================================

test(
  'TypeScript infrastructure: post owner can delete a post',
  async (t) => {

    // Record calls to the mocked delete function.

    const deletedPostIds: number[] = [];


    // ========================================================
    // 1. Define a function for unexpected repository calls
    // ========================================================

    const unexpectedCall = async (): Promise<never> => {
      throw new Error(
        'Unexpected repository function was called.'
      );
    };


    // ========================================================
    // 2. Mock the repository module
    // ========================================================

    t.mock.module(
      new URL('./posts.repositories.js', import.meta.url),
      {
        exports: {

          createPost: unexpectedCall,

          getAllPosts: unexpectedCall,

          getByIdPost: async (postId: number) => ({
            id: postId,
            authorId: 7
          }),

          getCommunityById: unexpectedCall,

          getPostVote: unexpectedCall,

          removePost: async (postId: number) => {
            deletedPostIds.push(postId);
          },

          setPostVote: unexpectedCall,

          updatePost: unexpectedCall
        }
      }
    );


    // ========================================================
    // 3. Mock the post mapper
    // ========================================================

    t.mock.module(
      new URL('./posts.mapper.js', import.meta.url),
      {
        exports: {
          toPostContract: (post: unknown) => post
        }
      }
    );


    // ========================================================
    // 4. Import the actual service after mocking
    // ========================================================

    const { removePostService } = await import(
      './posts.service.js'
    );


    // ========================================================
    // 5. Execute the service
    // ========================================================

    const result = await removePostService(
      42,
      7
    );


    // ========================================================
    // 6. Verify the result
    // ========================================================

    assert.deepEqual(
      result,
      { success: true }
    );

    assert.deepEqual(
      deletedPostIds,
      [42]
    );

  }
);
