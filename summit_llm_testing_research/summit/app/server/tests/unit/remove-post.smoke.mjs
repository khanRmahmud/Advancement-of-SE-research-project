
/*
 * Summit LLM Testing Research
 *
 * Infrastructure smoke test:
 * Verify that removePostService() can be unit-tested
 * with mocked repository dependencies.
 *
 * This test is NOT part of either LLM experimental group.
 * It does not use PostgreSQL, Docker, or the GPT API.
 */

import test from 'node:test';
import assert from 'node:assert/strict';


// ============================================================
// STEP 1: Test post deletion with mocked dependencies
// ============================================================

test(
  'removePostService deletes a post owned by the user',
  async (t) => {

    // Record whether the delete function is called.
    const deletedPostIds = [];


    // ========================================================
    // STEP 2: Locate compiled backend modules
    // ========================================================

    const repositoriesUrl = new URL(
      '../../dist/posts/posts.repositories.js',
      import.meta.url
    );

    const mapperUrl = new URL(
      '../../dist/posts/posts.mapper.js',
      import.meta.url
    );

    const serviceUrl = new URL(
      '../../dist/posts/posts.service.js',
      import.meta.url
    );


    // ========================================================
    // STEP 3: Mock repository functions
    // ========================================================

    const unused = () => {
      throw new Error(
        'Unexpected repository call in smoke test'
      );
    };

    t.mock.module(repositoriesUrl, {
      namedExports: {

        createPost: unused,

        getAllPosts: unused,

        getByIdPost: async (postId) => {
          return {
            id: postId,
            authorId: 7
          };
        },

        getCommunityById: unused,

        getPostVote: unused,

        removePost: async (postId) => {
          deletedPostIds.push(postId);
        },

        setPostVote: unused,

        updatePost: unused
      }
    });


    // ========================================================
    // STEP 4: Mock post mapping
    // ========================================================

    t.mock.module(mapperUrl, {
      namedExports: {
        toPostContract: (post) => post
      }
    });


    // ========================================================
    // STEP 5: Import service AFTER installing mocks
    // ========================================================

    const { removePostService } = await import(
      serviceUrl.href
    );


    // ========================================================
    // STEP 6: Execute the actual service function
    // ========================================================

    const result = await removePostService(
      42,  // Post ID
      7    // User ID (same as author)
    );


    // ========================================================
    // STEP 7: Verify expected behavior
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
